import Foundation

enum AccountAPIConfig {
    static let baseURL = URL(
        string: "https://28hdesign-ffbtgchvdyd2d8cq.canadacentral-01.azurewebsites.net"
    )!
}

enum AccountAPIError: LocalizedError {
    case invalidResponse
    case server(status: Int, message: String)
    case message(String)

    var errorDescription: String? {
        switch self {
        case .invalidResponse:
            return "Unexpected response from the server."
        case .server(_, let message):
            return message
        case .message(let text):
            return text
        }
    }
}

/// Azure backend for password reset (OTP) and account deletion.
enum AccountAPIClient {
    private static let session = URLSession.shared
    private static let decoder = JSONDecoder()

    // MARK: - Password reset

    static func sendPasswordResetOTP(email: String) async throws {
        struct Body: Encodable { let email: String }
        _ = try await postJSON(
            path: "/api/password-reset/send-otp",
            body: Body(email: email)
        )
    }

    /// Returns the secret required by `setPassword`.
    static func verifyPasswordResetOTP(email: String, otp: String) async throws -> String {
        struct Body: Encodable {
            let email: String
            let otp: String
        }
        let data = try await postJSON(
            path: "/api/password-reset/verify-otp",
            body: Body(email: email, otp: otp)
        )
        guard let secret = extractSecret(from: data) else {
            throw AccountAPIError.message("Verification succeeded but no secret was returned.")
        }
        return secret
    }

    static func setPassword(email: String, secret: String, newPassword: String) async throws {
        struct Body: Encodable {
            let email: String
            let secret: String
            let newPassword: String
        }
        _ = try await postJSON(
            path: "/api/password-reset/set-password",
            body: Body(email: email, secret: secret, newPassword: newPassword)
        )
    }

    // MARK: - Delete account

    static func deleteAccount(accessToken: String) async throws {
        var request = URLRequest(url: endpoint("api/account/delete"))
        request.httpMethod = "POST"
        request.setValue("Bearer \(accessToken)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = Data("{}".utf8)

        let (data, response) = try await session.data(for: request)
        try validate(response: response, data: data)
    }

    // MARK: - HTTP

    private static func endpoint(_ path: String) -> URL {
        let trimmed = path.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        return AccountAPIConfig.baseURL.appending(path: trimmed)
    }

    @discardableResult
    private static func postJSON<Body: Encodable>(path: String, body: Body) async throws -> Data {
        var request = URLRequest(url: endpoint(path))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONEncoder().encode(body)

        let (data, response) = try await session.data(for: request)
        try validate(response: response, data: data)
        return data
    }

    private static func validate(response: URLResponse, data: Data) throws {
        guard let http = response as? HTTPURLResponse else {
            throw AccountAPIError.invalidResponse
        }
        guard (200..<300).contains(http.statusCode) else {
            throw AccountAPIError.server(
                status: http.statusCode,
                message: extractErrorMessage(from: data) ?? "Request failed (\(http.statusCode))."
            )
        }
    }

    private static func extractSecret(from data: Data) -> String? {
        guard let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            return nil
        }
        if let secret = root["secret"] as? String, !secret.isEmpty { return secret }
        if let token = root["token"] as? String, !token.isEmpty { return token }
        if let nested = root["data"] as? [String: Any] {
            if let secret = nested["secret"] as? String, !secret.isEmpty { return secret }
            if let token = nested["token"] as? String, !token.isEmpty { return token }
        }
        return nil
    }

    private static func extractErrorMessage(from data: Data) -> String? {
        guard let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            return String(data: data, encoding: .utf8).flatMap { $0.isEmpty ? nil : $0 }
        }
        for key in ["message", "error", "title", "detail"] {
            if let text = root[key] as? String, !text.isEmpty { return text }
        }
        if let errors = root["errors"] as? [String], let first = errors.first {
            return first
        }
        return nil
    }
}
