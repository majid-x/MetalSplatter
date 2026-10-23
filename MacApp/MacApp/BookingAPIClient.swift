import Foundation

enum BookingAPIConfig {
    static let baseURL = URL(string: "https://www.vroomk.com")!
    /// Stripe publishable key only — secrets stay on the server.
    static let stripePublishableKey =
        "pk_live_51S1DjTGsyIZa17guzzEEhG1Pievnwgfz3BFT4qnh6ldLcjFzpVu7gS9Jvu8F5cd5u3ud5WCoZfYGqEv43Vinf3qC00ZWU8IjGo"
}

enum BookingAPIError: LocalizedError {
    case invalidResponse
    case server(status: Int, message: String)
    case message(String)

    var errorDescription: String? {
        switch self {
        case .invalidResponse:
            return "Unexpected response from the booking server."
        case .server(_, let message):
            return message
        case .message(let text):
            return text
        }
    }
}

struct BookingGeocodeResponse: Decodable {
    let status: String
    let message: String?
    let results: [BookingPlaceDTO]?
    let place: BookingPlaceDTO?
}

struct BookingPlaceDTO: Decodable {
    let lat: Double
    let lng: Double
    let label: String
    let countryCode: String?
    let country: String?
    let inServiceCountry: Bool?

    func asPlace() -> BookingPlace {
        BookingPlace(
            lat: lat,
            lng: lng,
            label: label,
            countryCode: countryCode,
            country: country,
            inServiceCountry: inServiceCountry
        )
    }
}

struct BookedTimesResponse: Decodable {
    let date: String
    let bookedTimes: [String]
    let appointmentStarts: [String]?
}

struct CreatePaymentIntentResponse: Decodable {
    let success: Bool?
    let clientSecret: String
    let paymentIntentId: String
    let amount: Int?
    let amountDisplay: String?
    let currency: String?
}

struct ConfirmPaymentResponse: Decodable {
    let success: Bool?
    let paymentIntentId: String?
}

struct ScheduleMeetingResponse: Decodable {
    let success: Bool?
    let link: String?
    let meetLink: String?
}

struct SaveBookingDraftResponse: Decodable {
    let message: String?
    let data: [BookingDraftRow]?
}

struct BookingDraftRow: Decodable {
    let id: String
    let email: String?
    let name: String?
    let date: String?
    let time: String?
}

enum BookingAPIClient {
    private static let session = URLSession.shared
    private static let decoder: JSONDecoder = {
        let d = JSONDecoder()
        return d
    }()

    // MARK: - Geocode

    static func geocode(query: String) async throws -> BookingGeocodeResponse {
        var components = URLComponents(
            url: BookingAPIConfig.baseURL.appending(path: "api/booking/geocode"),
            resolvingAgainstBaseURL: false
        )!
        components.queryItems = [URLQueryItem(name: "q", value: query)]
        guard let url = components.url else { throw BookingAPIError.invalidResponse }
        return try await getJSON(url: url)
    }

    static func reverseGeocode(lat: Double, lng: Double) async throws -> BookingGeocodeResponse {
        var components = URLComponents(
            url: BookingAPIConfig.baseURL.appending(path: "api/booking/reverse-geocode"),
            resolvingAgainstBaseURL: false
        )!
        components.queryItems = [
            URLQueryItem(name: "lat", value: String(lat)),
            URLQueryItem(name: "lng", value: String(lng)),
        ]
        guard let url = components.url else { throw BookingAPIError.invalidResponse }
        return try await getJSON(url: url)
    }

    // MARK: - Availability

    static func bookedTimes(date: String) async throws -> BookedTimesResponse {
        var components = URLComponents(
            url: BookingAPIConfig.baseURL.appending(path: "api/booked-times"),
            resolvingAgainstBaseURL: false
        )!
        components.queryItems = [URLQueryItem(name: "date", value: date)]
        guard let url = components.url else { throw BookingAPIError.invalidResponse }
        return try await getJSON(url: url)
    }

    // MARK: - Payment

    static func createPaymentIntent(name: String, email: String, phone: String) async throws -> CreatePaymentIntentResponse {
        struct Body: Encodable {
            let name: String
            let email: String
            let phone: String
        }
        return try await postJSON(
            path: "api/booking/create-payment-intent",
            body: Body(name: name, email: email, phone: phone)
        )
    }

    static func confirmPayment(paymentIntentId: String) async throws -> ConfirmPaymentResponse {
        struct Body: Encodable { let paymentIntentId: String }
        return try await postJSON(
            path: "api/booking/confirm-payment",
            body: Body(paymentIntentId: paymentIntentId)
        )
    }

    // MARK: - Schedule

    struct ScheduleBody: Encodable {
        let name: String
        let email: String
        let phone: String
        let date: String
        let time: String
        let address: String
        let lat: Double
        let lng: Double
        let scanScope: String
        let scanScopeLabel: String
        let inCoverage: Bool
        let inServiceCountry: Bool
        let distanceKm: Double
        let paymentIntentId: String?
        let advancePaid: Bool
        let advanceAmount: String?
    }

    static func scheduleMeeting(_ body: ScheduleBody) async throws -> ScheduleMeetingResponse {
        try await postJSON(path: "api/schedule-meeting", body: body)
    }

    // MARK: - Draft (progressive save / abandoned cart)

    /// Upserts a draft on the website. Server keys rows primarily by `email` when present.
    struct DraftBody: Encodable {
        var id: String?
        var email: String?
        var name: String?
        var phone: String?
        var date: String?
        var time: String?
        var address: String?
        var location: String?
        var lat: Double?
        var lng: Double?
        var scanScope: String?
        var house_coverage: String?
        var inCoverage: Bool?
        var distanceKm: Double?
        var payment_status: String?
        var paymentIntentId: String?
    }

    @discardableResult
    static func saveBookingDraft(_ body: DraftBody) async throws -> SaveBookingDraftResponse {
        try await postJSON(path: "api/save-booking-draft", body: body)
    }

    // MARK: - HTTP

    private static func getJSON<T: Decodable>(url: URL) async throws -> T {
        var request = URLRequest(url: url)
        request.httpMethod = "GET"
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        let (data, response) = try await session.data(for: request)
        try validate(response: response, data: data)
        return try decoder.decode(T.self, from: data)
    }

    private static func postJSON<Body: Encodable, T: Decodable>(path: String, body: Body) async throws -> T {
        var request = URLRequest(url: endpoint(path))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.httpBody = try JSONEncoder().encode(body)
        let (data, response) = try await session.data(for: request)
        try validate(response: response, data: data)
        return try decoder.decode(T.self, from: data)
    }

    private static func endpoint(_ path: String) -> URL {
        let trimmed = path.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        return BookingAPIConfig.baseURL.appending(path: trimmed)
    }

    private static func validate(response: URLResponse, data: Data) throws {
        guard let http = response as? HTTPURLResponse else {
            throw BookingAPIError.invalidResponse
        }
        guard (200..<300).contains(http.statusCode) else {
            throw BookingAPIError.server(
                status: http.statusCode,
                message: extractErrorMessage(from: data) ?? defaultMessage(for: http.statusCode)
            )
        }
    }

    private static func defaultMessage(for status: Int) -> String {
        switch status {
        case 409: return "That time slot is no longer available. Pick another."
        case 402: return "Payment was not completed. Please try again."
        case 401, 403: return "Booking calendar is temporarily unavailable."
        default: return "Request failed (\(status))."
        }
    }

    private static func extractErrorMessage(from data: Data) -> String? {
        guard let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            return String(data: data, encoding: .utf8).flatMap { $0.isEmpty ? nil : $0 }
        }
        for key in ["message", "error", "title", "detail"] {
            if let text = root[key] as? String, !text.isEmpty { return text }
        }
        return nil
    }
}
