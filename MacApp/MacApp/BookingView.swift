import CoreLocation
import SwiftUI

@MainActor
@Observable
private final class BookingLocationProvider: NSObject, CLLocationManagerDelegate {
    private let manager = CLLocationManager()
    var lastError: String?
    private var continuation: CheckedContinuation<CLLocationCoordinate2D, Error>?

    override init() {
        super.init()
        manager.delegate = self
        manager.desiredAccuracy = kCLLocationAccuracyHundredMeters
    }

    func requestCoordinate() async throws -> CLLocationCoordinate2D {
        lastError = nil
        switch manager.authorizationStatus {
        case .notDetermined:
            manager.requestWhenInUseAuthorization()
        case .denied, .restricted:
            throw BookingAPIError.message(
                "Location access is denied. Enable it in System Settings, or search by address."
            )
        default:
            break
        }
        return try await withCheckedThrowingContinuation { cont in
            self.continuation = cont
            self.manager.requestLocation()
        }
    }

    nonisolated func locationManager(
        _ manager: CLLocationManager,
        didUpdateLocations locations: [CLLocation]
    ) {
        guard let coord = locations.last?.coordinate else { return }
        Task { @MainActor in
            self.continuation?.resume(returning: coord)
            self.continuation = nil
        }
    }

    nonisolated func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
        Task { @MainActor in
            self.continuation?.resume(throwing: error)
            self.continuation = nil
        }
    }

    nonisolated func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        // Wait for explicit requestLocation after permission grant.
    }
}

struct BookingView: View {
    @Environment(AuthManager.self) private var authManager
    @Environment(\.horizontalSizeClass) private var sizeClass

    @State private var step: BookingStep = .location
    @State private var addressQuery = ""
    @State private var suggestions: [BookingPlace] = []
    @State private var locationGate: BookingLocationGate = .idle
    @State private var selectedPlace: BookingPlace?
    @State private var coverage: BookingCoverage?
    @State private var scanScope: BookingScanScope = .entireHouse
    @State private var selectedDate = BookingSlots.minSelectableDate(inCoverage: true)
    @State private var selectedTime24: String?
    @State private var bookedTimes: Set<String> = []
    @State private var name = ""
    @State private var email = ""
    @State private var phone = ""
    @State private var paymentIntentId: String?
    @State private var paymentClientSecret: String?
    @State private var calendarLink: String?
    @State private var isBusy = false
    @State private var isSearching = false
    @State private var isLoadingSlots = false
    @State private var errorMessage: String?
    @State private var geocodeTask: Task<Void, Never>?
    @State private var locationProvider = BookingLocationProvider()

    private var isCompact: Bool { sizeClass == .compact }

    private var availableTimes: [String] {
        BookingSlots.allTimes24h.filter { !bookedTimes.contains($0) }
    }

    private var phoneDigits: String {
        phone.filter(\.isNumber)
    }

    private var emailValid: Bool {
        let trimmed = email.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let at = trimmed.firstIndex(of: "@"),
              at > trimmed.startIndex,
              let dot = trimmed[trimmed.index(after: at)...].lastIndex(of: "."),
              trimmed.distance(from: dot, to: trimmed.endIndex) > 1
        else { return false }
        return !trimmed.contains(" ")
    }

    private var contactValid: Bool {
        !name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && emailValid
            && phoneDigits.count >= 10
    }

    private var canContinueLocation: Bool {
        locationGate == .ok && selectedPlace != nil && coverage != nil
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 28) {
                header
                progressBar
                if let errorMessage {
                    Text(errorMessage)
                        .font(.system(size: 13))
                        .foregroundStyle(Color(red: 0.95, green: 0.55, blue: 0.52))
                }
                stepContent
                navButtons
            }
            .padding(.horizontal, isCompact ? 20 : 36)
            .padding(.top, 12)
            .padding(.bottom, 40)
            .frame(maxWidth: 720, alignment: .leading)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .onAppear(perform: hydrateContact)
        .onChange(of: addressQuery) { _, newValue in
            scheduleGeocode(for: newValue)
        }
        .onChange(of: selectedDate) { _, _ in
            Task { await loadBookedTimes() }
        }
        .onChange(of: coverage?.inCoverage) { _, inCoverage in
            guard let inCoverage else { return }
            let minDate = BookingSlots.minSelectableDate(inCoverage: inCoverage)
            if selectedDate < minDate {
                selectedDate = minDate
            }
        }
    }

    // MARK: - Header / progress

    private var header: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Book a scan")
                .font(.system(size: 40, weight: .ultraLight))
                .foregroundStyle(.white)

            Text("Schedule an on-site Vroomk scan. \(BookingGeo.rateDisplay) · \(BookingGeo.advanceDisplay) advance inside coverage.")
                .font(.system(size: 14, weight: .regular))
                .foregroundStyle(.white.opacity(0.42))
        }
    }

    private var progressBar: some View {
        HStack(spacing: 8) {
            ForEach(Array(BookingStep.progressLabels.enumerated()), id: \.offset) { index, label in
                let active = index <= step.progressIndex
                VStack(spacing: 6) {
                    Capsule()
                        .fill(active ? Color.white.opacity(0.85) : Color.white.opacity(0.12))
                        .frame(height: 3)
                    Text(label)
                        .font(.system(size: 11, weight: active ? .medium : .regular))
                        .foregroundStyle(active ? .white.opacity(0.75) : .white.opacity(0.3))
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
        }
    }

    @ViewBuilder
    private var stepContent: some View {
        switch step {
        case .location:
            locationStep
        case .scan:
            scanStep
        case .schedule:
            scheduleStep
        case .contact:
            contactStep
        case .payment:
            paymentStep
        case .done:
            doneStep
        }
    }

    // MARK: - Steps

    private var locationStep: some View {
        VStack(alignment: .leading, spacing: 16) {
            card(title: "Location", subtitle: "Search a US address or use your current location.") {
                VStack(alignment: .leading, spacing: 14) {
                    field(title: "Address", text: $addressQuery, prompt: "Street, city, state…")

                    HStack(spacing: 10) {
                        Button {
                            Task { await useCurrentLocation() }
                        } label: {
                            pillLabel(title: isBusy ? "Locating…" : "Use current location", systemImage: "location")
                        }
                        .buttonStyle(.plain)
                        .disabled(isBusy)

                        if isSearching {
                            ProgressView()
                                .controlSize(.small)
                                .tint(.white)
                        }
                    }

                    if !suggestions.isEmpty {
                        VStack(alignment: .leading, spacing: 0) {
                            ForEach(suggestions) { place in
                                Button {
                                    selectPlace(place)
                                } label: {
                                    HStack {
                                        Image(systemName: "mappin.and.ellipse")
                                            .foregroundStyle(.white.opacity(0.45))
                                        Text(place.label)
                                            .font(.system(size: 13))
                                            .foregroundStyle(.white.opacity(0.9))
                                            .multilineTextAlignment(.leading)
                                        Spacer()
                                    }
                                    .padding(.vertical, 10)
                                    .padding(.horizontal, 4)
                                    .contentShape(Rectangle())
                                }
                                .buttonStyle(.plain)
                                Divider().overlay(Color.white.opacity(0.08))
                            }
                        }
                    }

                    if let gateMessage = locationGate.message {
                        Text(gateMessage)
                            .font(.system(size: 13))
                            .foregroundStyle(Color(red: 0.95, green: 0.72, blue: 0.45))
                    }

                    if let place = selectedPlace {
                        HStack(alignment: .top, spacing: 10) {
                            VStack(alignment: .leading, spacing: 8) {
                                Text(place.label)
                                    .font(.system(size: 14, weight: .medium))
                                    .foregroundStyle(.white)
                                if let coverage {
                                    Text(
                                        coverage.inCoverage
                                            ? "Inside coverage · \(String(format: "%.1f", coverage.distanceMiles)) mi · \(BookingGeo.advanceDisplay) advance required"
                                            : "Outside coverage · \(String(format: "%.1f", coverage.distanceMiles)) mi · no advance; earliest date is tomorrow"
                                    )
                                    .font(.system(size: 13))
                                    .foregroundStyle(.white.opacity(0.45))
                                    Text("Rate \(BookingGeo.rateDisplay) · base \(BookingGeo.baseLabel)")
                                        .font(.system(size: 12))
                                        .foregroundStyle(.white.opacity(0.3))
                                }
                            }
                            .frame(maxWidth: .infinity, alignment: .leading)

                            Button {
                                clearSelectedLocation()
                            } label: {
                                Image(systemName: "xmark.circle.fill")
                                    .font(.system(size: 18))
                                    .foregroundStyle(.white.opacity(0.45))
                            }
                            .buttonStyle(.plain)
                            .help("Clear selected location")
                        }
                        .padding(.top, 4)
                    }
                }
            }

            BookingCoverageAside(compactMapHeight: isCompact)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    private var scanStep: some View {
        card(title: "Scan area", subtitle: "What should we capture on site?") {
            VStack(alignment: .leading, spacing: 8) {
                ForEach(BookingScanScope.allCases) { scope in
                    Button {
                        scanScope = scope
                    } label: {
                        HStack {
                            Image(systemName: scanScope == scope ? "checkmark.circle.fill" : "circle")
                                .foregroundStyle(scanScope == scope ? .white : .white.opacity(0.35))
                            Text(scope.label)
                                .font(.system(size: 14, weight: scanScope == scope ? .medium : .regular))
                                .foregroundStyle(.white)
                            Spacer()
                        }
                        .padding(.vertical, 10)
                        .padding(.horizontal, 12)
                        .background {
                            RoundedRectangle(cornerRadius: 10, style: .continuous)
                                .fill(scanScope == scope ? Color.white.opacity(0.08) : Color.clear)
                        }
                    }
                    .buttonStyle(.plain)
                }
            }
        }
    }

    private var scheduleStep: some View {
        card(title: "Time", subtitle: "Pacific time · each visit is 4 hours.") {
            VStack(alignment: .leading, spacing: 16) {
                DatePicker(
                    "Date",
                    selection: $selectedDate,
                    in: BookingSlots.minSelectableDate(inCoverage: coverage?.inCoverage ?? false)...,
                    displayedComponents: .date
                )
                .datePickerStyle(.graphical)
                .tint(Color(red: 0.45, green: 0.82, blue: 0.92))
                .colorScheme(.dark)

                if isLoadingSlots {
                    ProgressView()
                        .controlSize(.small)
                        .tint(.white)
                } else if availableTimes.isEmpty {
                    Text("No open slots on this day. Try another date.")
                        .font(.system(size: 13))
                        .foregroundStyle(.white.opacity(0.45))
                } else {
                    LazyVGrid(
                        columns: [GridItem(.adaptive(minimum: 88), spacing: 8)],
                        spacing: 8
                    ) {
                        ForEach(availableTimes, id: \.self) { time in
                            Button {
                                selectedTime24 = time
                            } label: {
                                Text(BookingSlots.display12h(time))
                                    .font(.system(size: 13, weight: selectedTime24 == time ? .medium : .regular))
                                    .foregroundStyle(.white)
                                    .frame(maxWidth: .infinity)
                                    .padding(.vertical, 10)
                                    .background {
                                        RoundedRectangle(cornerRadius: 10, style: .continuous)
                                            .fill(
                                                selectedTime24 == time
                                                    ? Color.white.opacity(0.14)
                                                    : Color.white.opacity(0.05)
                                            )
                                            .overlay {
                                                RoundedRectangle(cornerRadius: 10, style: .continuous)
                                                    .strokeBorder(
                                                        selectedTime24 == time
                                                            ? Color.white.opacity(0.35)
                                                            : Color.white.opacity(0.08),
                                                        lineWidth: 1
                                                    )
                                            }
                                    }
                            }
                            .buttonStyle(.plain)
                        }
                    }
                }
            }
        }
        .task {
            await loadBookedTimes()
        }
    }

    private var contactStep: some View {
        card(title: "Details", subtitle: "We'll confirm by email and text.") {
            VStack(alignment: .leading, spacing: 14) {
                field(title: "Name", text: $name, prompt: "Full name")
                field(title: "Email", text: $email, prompt: "you@example.com")
                field(title: "Phone", text: $phone, prompt: "+1 …")

                if coverage?.inCoverage == true {
                    Text("Next you'll pay a \(BookingGeo.advanceDisplay) advance to confirm.")
                        .font(.system(size: 13))
                        .foregroundStyle(.white.opacity(0.45))
                } else {
                    Text("Outside coverage — no advance. We'll confirm your request.")
                        .font(.system(size: 13))
                        .foregroundStyle(.white.opacity(0.45))
                }
            }
        }
    }

    private var paymentStep: some View {
        card(title: "Payment", subtitle: "\(BookingGeo.advanceDisplay) booking advance (card).") {
            Group {
                if let secret = paymentClientSecret {
                    BookingPaymentWebView(
                        publishableKey: BookingAPIConfig.stripePublishableKey,
                        clientSecret: secret,
                        amountDisplay: BookingGeo.advanceDisplay,
                        onSuccess: { piId in
                            Task { await finishAfterStripe(paymentIntentId: piId) }
                        },
                        onError: { message in
                            errorMessage = message
                        }
                    )
                    .frame(minHeight: 260)
                } else {
                    ProgressView("Preparing payment…")
                        .tint(.white)
                }
            }
        }
    }

    private var doneStep: some View {
        card(title: "You're booked", subtitle: "We'll see you on site.") {
            VStack(alignment: .leading, spacing: 14) {
                Text("Thanks, \(name.trimmingCharacters(in: .whitespacesAndNewlines)). Your Vroomk scan is confirmed.")
                    .font(.system(size: 14))
                    .foregroundStyle(.white.opacity(0.85))

                if let place = selectedPlace, let time = selectedTime24 {
                    Text("\(place.label)\n\(BookingSlots.pacificDateString(from: selectedDate)) · \(BookingSlots.display12h(time)) PT · \(scanScope.label)")
                        .font(.system(size: 13))
                        .foregroundStyle(.white.opacity(0.45))
                }

                if let link = calendarLink, let url = URL(string: link) {
                    Link("Open calendar event", destination: url)
                        .font(.system(size: 13, weight: .medium))
                }

                Button {
                    resetWizard()
                } label: {
                    pillLabel(title: "Book another", systemImage: "plus")
                }
                .buttonStyle(.plain)
                .padding(.top, 8)
            }
        }
    }

    // MARK: - Navigation

    private var navButtons: some View {
        HStack(spacing: 12) {
            if step != .location && step != .done {
                Button {
                    goBack()
                } label: {
                    pillLabel(title: "Back", systemImage: "chevron.left")
                }
                .buttonStyle(.plain)
                .disabled(isBusy)
            }

            Spacer()

            if step != .done && step != .payment {
                Button {
                    Task { await goForward() }
                } label: {
                    pillLabel(
                        title: primaryActionTitle,
                        systemImage: "chevron.right",
                        busy: isBusy,
                        prominent: true
                    )
                }
                .buttonStyle(.plain)
                .disabled(isBusy || !canAdvance)
            }
        }
    }

    private var primaryActionTitle: String {
        switch step {
        case .contact:
            return coverage?.inCoverage == true ? "Continue to payment" : "Confirm booking"
        case .location, .scan, .schedule:
            return "Continue"
        case .payment, .done:
            return "Continue"
        }
    }

    private var canAdvance: Bool {
        switch step {
        case .location: return canContinueLocation
        case .scan: return true
        case .schedule: return selectedTime24 != nil
        case .contact: return contactValid
        case .payment, .done: return false
        }
    }

    // MARK: - Actions

    private func goBack() {
        errorMessage = nil
        switch step {
        case .scan: step = .location
        case .schedule: step = .scan
        case .contact: step = .schedule
        case .payment:
            paymentClientSecret = nil
            paymentIntentId = nil
            step = .contact
        default: break
        }
    }

    private func goForward() async {
        errorMessage = nil
        switch step {
        case .location:
            step = .scan
        case .scan:
            step = .schedule
            await loadBookedTimes()
        case .schedule:
            step = .contact
        case .contact:
            await submitContact()
        default:
            break
        }
    }

    private func submitContact() async {
        guard let place = selectedPlace, let coverage, let time = selectedTime24 else { return }
        isBusy = true
        defer { isBusy = false }

        if coverage.inCoverage {
            do {
                let intent = try await BookingAPIClient.createPaymentIntent(
                    name: name.trimmingCharacters(in: .whitespacesAndNewlines),
                    email: email.trimmingCharacters(in: .whitespacesAndNewlines).lowercased(),
                    phone: phone.trimmingCharacters(in: .whitespacesAndNewlines)
                )
                paymentIntentId = intent.paymentIntentId
                paymentClientSecret = intent.clientSecret
                step = .payment
            } catch {
                errorMessage = error.localizedDescription
            }
            return
        }

        do {
            let response = try await BookingAPIClient.scheduleMeeting(
                makeScheduleBody(
                    place: place,
                    coverage: coverage,
                    time: time,
                    paymentIntentId: nil,
                    advancePaid: false
                )
            )
            calendarLink = response.link
            step = .done
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func finishAfterStripe(paymentIntentId piId: String) async {
        guard let place = selectedPlace, let coverage, let time = selectedTime24 else { return }
        isBusy = true
        defer { isBusy = false }
        errorMessage = nil
        paymentIntentId = piId

        do {
            _ = try await BookingAPIClient.confirmPayment(paymentIntentId: piId)
            let response = try await BookingAPIClient.scheduleMeeting(
                makeScheduleBody(
                    place: place,
                    coverage: coverage,
                    time: time,
                    paymentIntentId: piId,
                    advancePaid: true
                )
            )
            calendarLink = response.link
            step = .done
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func makeScheduleBody(
        place: BookingPlace,
        coverage: BookingCoverage,
        time: String,
        paymentIntentId: String?,
        advancePaid: Bool
    ) -> BookingAPIClient.ScheduleBody {
        BookingAPIClient.ScheduleBody(
            name: name.trimmingCharacters(in: .whitespacesAndNewlines),
            email: email.trimmingCharacters(in: .whitespacesAndNewlines).lowercased(),
            phone: phone.trimmingCharacters(in: .whitespacesAndNewlines),
            date: BookingSlots.pacificDateString(from: selectedDate),
            time: time,
            address: place.label,
            lat: place.lat,
            lng: place.lng,
            scanScope: scanScope.rawValue,
            scanScopeLabel: scanScope.label,
            inCoverage: coverage.inCoverage,
            inServiceCountry: place.isUS,
            distanceKm: coverage.distanceKm,
            paymentIntentId: paymentIntentId,
            advancePaid: advancePaid,
            advanceAmount: advancePaid ? BookingGeo.advanceDisplay : nil
        )
    }

    private func selectPlace(_ place: BookingPlace) {
        errorMessage = nil
        if BookingGeo.isFakeCoordinate(lat: place.lat, lng: place.lng) {
            selectedPlace = nil
            coverage = nil
            locationGate = .fake
            return
        }
        if !place.isUS {
            selectedPlace = place
            coverage = nil
            locationGate = .outOfCountry
            return
        }
        selectedPlace = place
        coverage = BookingGeo.coverage(for: place)
        addressQuery = place.label
        suggestions = []
        locationGate = .ok
        let minDate = BookingSlots.minSelectableDate(inCoverage: coverage?.inCoverage ?? false)
        if selectedDate < minDate {
            selectedDate = minDate
        }
    }

    private func clearSelectedLocation() {
        selectedPlace = nil
        coverage = nil
        addressQuery = ""
        suggestions = []
        locationGate = .idle
        errorMessage = nil
        selectedDate = BookingSlots.minSelectableDate(inCoverage: true)
    }

    private func scheduleGeocode(for query: String) {
        geocodeTask?.cancel()
        let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.count >= 3 else {
            suggestions = []
            if selectedPlace == nil { locationGate = .idle }
            return
        }
        if let selected = selectedPlace, selected.label == trimmed {
            return
        }
        geocodeTask = Task {
            try? await Task.sleep(for: .milliseconds(450))
            guard !Task.isCancelled else { return }
            await runGeocode(trimmed)
        }
    }

    private func runGeocode(_ query: String) async {
        isSearching = true
        defer { isSearching = false }
        do {
            let response = try await BookingAPIClient.geocode(query: query)
            guard !Task.isCancelled else { return }
            let places = (response.results ?? []).map { $0.asPlace() }
            suggestions = places
            switch response.status {
            case "ok":
                locationGate = places.isEmpty ? .notFound : .pickSuggestion
                if selectedPlace != nil, !places.contains(where: { $0.label == selectedPlace?.label }) {
                    selectedPlace = nil
                    coverage = nil
                }
            case "out_of_country":
                locationGate = .outOfCountry
                selectedPlace = nil
                coverage = nil
            case "not_found":
                locationGate = .notFound
                selectedPlace = nil
                coverage = nil
            case "fake":
                locationGate = .fake
                selectedPlace = nil
                coverage = nil
            default:
                locationGate = places.isEmpty ? .notFound : .pickSuggestion
            }
        } catch {
            if !Task.isCancelled {
                errorMessage = error.localizedDescription
            }
        }
    }

    private func useCurrentLocation() async {
        isBusy = true
        errorMessage = nil
        defer { isBusy = false }
        do {
            let coord = try await locationProvider.requestCoordinate()
            if BookingGeo.isFakeCoordinate(lat: coord.latitude, lng: coord.longitude) {
                locationGate = .fake
                return
            }
            let response = try await BookingAPIClient.reverseGeocode(
                lat: coord.latitude,
                lng: coord.longitude
            )
            switch response.status {
            case "ok":
                if let place = response.place?.asPlace() {
                    selectPlace(place)
                } else {
                    locationGate = .notFound
                }
            case "out_of_country":
                locationGate = .outOfCountry
            case "fake":
                locationGate = .fake
            default:
                locationGate = .notFound
                if let message = response.message {
                    errorMessage = message
                }
            }
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func loadBookedTimes() async {
        isLoadingSlots = true
        defer { isLoadingSlots = false }
        let dateString = BookingSlots.pacificDateString(from: selectedDate)
        do {
            let response = try await BookingAPIClient.bookedTimes(date: dateString)
            bookedTimes = Set(response.bookedTimes)
            if let selectedTime24, bookedTimes.contains(selectedTime24) {
                self.selectedTime24 = nil
            }
        } catch {
            errorMessage = error.localizedDescription
            bookedTimes = []
        }
    }

    private func hydrateContact() {
        if name.isEmpty { name = authManager.fullName ?? "" }
        if email.isEmpty { email = authManager.email ?? "" }
    }

    private func resetWizard() {
        step = .location
        addressQuery = ""
        suggestions = []
        locationGate = .idle
        selectedPlace = nil
        coverage = nil
        scanScope = .entireHouse
        selectedDate = BookingSlots.minSelectableDate(inCoverage: true)
        selectedTime24 = nil
        bookedTimes = []
        paymentIntentId = nil
        paymentClientSecret = nil
        calendarLink = nil
        errorMessage = nil
        hydrateContact()
    }

    // MARK: - UI helpers

    private func card<Content: View>(
        title: String,
        subtitle: String,
        @ViewBuilder content: () -> Content
    ) -> some View {
        VStack(alignment: .leading, spacing: 16) {
            VStack(alignment: .leading, spacing: 4) {
                Text(title)
                    .font(.system(size: 16, weight: .medium))
                    .foregroundStyle(.white)
                Text(subtitle)
                    .font(.system(size: 12))
                    .foregroundStyle(.white.opacity(0.38))
            }
            content()
        }
        .padding(20)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background {
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .fill(.white.opacity(0.04))
                .overlay {
                    RoundedRectangle(cornerRadius: 16, style: .continuous)
                        .strokeBorder(.white.opacity(0.08), lineWidth: 1)
                }
        }
    }

    private func field(title: String, text: Binding<String>, prompt: String) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title)
                .font(.system(size: 12, weight: .medium))
                .foregroundStyle(.white.opacity(0.45))
            TextField(prompt, text: text)
                .textFieldStyle(.plain)
                .padding(.horizontal, 12)
                .padding(.vertical, 10)
                .background {
                    RoundedRectangle(cornerRadius: 10, style: .continuous)
                        .fill(.white.opacity(0.06))
                }
                .foregroundStyle(.white)
        }
    }

    private func pillLabel(
        title: String,
        systemImage: String? = nil,
        busy: Bool = false,
        prominent: Bool = false
    ) -> some View {
        HStack(spacing: 8) {
            if busy {
                ProgressView()
                    .controlSize(.small)
                    .tint(.white)
            } else {
                if let systemImage, !prominent {
                    Image(systemName: systemImage)
                        .font(.system(size: 12, weight: .medium))
                }
                Text(title)
                    .font(.system(size: 13, weight: .medium))
                if let systemImage, prominent {
                    Image(systemName: systemImage)
                        .font(.system(size: 11, weight: .semibold))
                }
            }
        }
        .foregroundStyle(.white)
        .frame(height: 36)
        .padding(.horizontal, 16)
        .background {
            Capsule()
                .fill(prominent ? Color.white.opacity(0.14) : Color.white.opacity(0.08))
                .overlay {
                    Capsule().strokeBorder(.white.opacity(0.16), lineWidth: 1)
                }
        }
    }
}

#Preview {
    BookingView()
        .environment(AuthManager())
        .frame(width: 900, height: 700)
        .preferredColorScheme(.dark)
        .background(Color.black)
}
