import Foundation

enum BookingStep: String, CaseIterable, Identifiable {
    case location
    case scan
    case schedule
    case contact
    case payment
    case done

    var id: String { rawValue }

    /// Progress chip labels (payment is an extra step after Details).
    static let progressLabels = ["Location", "Scan area", "Time", "Details"]

    var progressIndex: Int {
        switch self {
        case .location: return 0
        case .scan: return 1
        case .schedule: return 2
        case .contact, .payment, .done: return 3
        }
    }
}

enum BookingScanScope: String, CaseIterable, Identifiable {
    case entireHouse = "entire_house"
    case groundFloor = "ground_floor"
    case singleRoom = "single_room"
    case custom = "custom"

    var id: String { rawValue }

    var label: String {
        switch self {
        case .entireHouse: return "Entire house"
        case .groundFloor: return "Ground floor"
        case .singleRoom: return "Single room"
        case .custom: return "Custom"
        }
    }
}

enum BookingLocationGate: Equatable {
    case idle
    case pickSuggestion
    case ok
    case outOfCountry
    case notFound
    case fake

    var message: String? {
        switch self {
        case .idle:
            return nil
        case .pickSuggestion:
            return "Select an address from the suggestions."
        case .ok:
            return nil
        case .outOfCountry:
            return "We don't provide services outside the United States."
        case .notFound:
            return "We couldn't verify that location. Try a fuller street address."
        case .fake:
            return "That location doesn't look valid. Try again or search by address."
        }
    }
}

struct BookingPlace: Equatable, Identifiable, Hashable {
    var id: String { "\(lat),\(lng),\(label)" }
    var lat: Double
    var lng: Double
    var label: String
    var countryCode: String?
    var country: String?
    var inServiceCountry: Bool?

    var isUS: Bool {
        if let inServiceCountry { return inServiceCountry }
        return (countryCode ?? "").lowercased() == "us"
    }
}

struct BookingCoverage: Equatable {
    var inCoverage: Bool
    var distanceKm: Double
    var distanceMiles: Double
}

enum BookingGeo {
    static let baseLat = 34.1869322
    static let baseLng = -118.5621216
    static let baseLabel = "6414 Corbin Ave, Reseda, CA 91335"
    static let radiusMiles = 60.0
    static let rateDisplay = "$1.50/sqft"
    static let advanceCents = 30_000
    static let advanceDisplay = "$300"

    private static let earthRadiusKm = 6371.0
    private static let milesPerKm = 0.621371

    static func coverage(for place: BookingPlace) -> BookingCoverage {
        let distanceKm = haversineKm(
            lat1: baseLat, lng1: baseLng,
            lat2: place.lat, lng2: place.lng
        )
        let distanceMiles = distanceKm * milesPerKm
        let radiusKm = radiusMiles / milesPerKm
        return BookingCoverage(
            inCoverage: distanceKm <= radiusKm,
            distanceKm: distanceKm,
            distanceMiles: distanceMiles
        )
    }

    static func haversineKm(lat1: Double, lng1: Double, lat2: Double, lng2: Double) -> Double {
        let dLat = (lat2 - lat1) * .pi / 180
        let dLng = (lng2 - lng1) * .pi / 180
        let a = sin(dLat / 2) * sin(dLat / 2)
            + cos(lat1 * .pi / 180) * cos(lat2 * .pi / 180)
            * sin(dLng / 2) * sin(dLng / 2)
        let c = 2 * atan2(sqrt(a), sqrt(1 - a))
        return earthRadiusKm * c
    }

    static func isFakeCoordinate(lat: Double, lng: Double) -> Bool {
        abs(lat) < 0.01 && abs(lng) < 0.01
    }
}

enum BookingSlots {
    static let pacific = TimeZone(identifier: "America/Los_Angeles")!
    static let allTimes24h = [
        "09:00", "10:00", "11:00", "12:00",
        "13:00", "14:00", "15:00", "16:00", "17:00",
    ]

    static var calendar: Calendar {
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = pacific
        return cal
    }

    /// Pacific calendar day as `YYYY-MM-DD`.
    static func pacificDateString(from date: Date = Date()) -> String {
        let comps = calendar.dateComponents([.year, .month, .day], from: date)
        let y = comps.year ?? 1970
        let m = comps.month ?? 1
        let d = comps.day ?? 1
        return String(format: "%04d-%02d-%02d", y, m, d)
    }

    static func date(fromPacificString string: String) -> Date? {
        let parts = string.split(separator: "-").compactMap { Int($0) }
        guard parts.count == 3 else { return nil }
        var comps = DateComponents()
        comps.year = parts[0]
        comps.month = parts[1]
        comps.day = parts[2]
        comps.hour = 12
        comps.timeZone = pacific
        return calendar.date(from: comps)
    }

    /// Minimum selectable date: today (in coverage) or tomorrow (outside).
    static func minSelectableDate(inCoverage: Bool, now: Date = Date()) -> Date {
        let todayStart = calendar.startOfDay(for: now)
        if inCoverage { return todayStart }
        return calendar.date(byAdding: .day, value: 1, to: todayStart) ?? todayStart
    }

    static func display12h(_ time24: String) -> String {
        let parts = time24.split(separator: ":")
        guard parts.count >= 2,
              let hour = Int(parts[0]),
              let minute = Int(parts[1])
        else { return time24 }
        let period = hour >= 12 ? "PM" : "AM"
        let h12 = hour % 12 == 0 ? 12 : hour % 12
        return String(format: "%d:%02d %@", h12, minute, period)
    }
}
