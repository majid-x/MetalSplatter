import Foundation
import Observation
import Supabase

enum AuthFlowError: LocalizedError {
    case emailConfirmationRequired
    case invalidCredentials
    case message(String)

    var errorDescription: String? {
        switch self {
        case .emailConfirmationRequired:
            return "Check your email to confirm your account, then sign in."
        case .invalidCredentials:
            return "Invalid email or password."
        case .message(let text):
            return text
        }
    }
}

@MainActor
@Observable
final class AuthManager {
    private(set) var session: Session?
    private(set) var isBootstrapping = true
    private(set) var statusMessage: String?

    var isAuthenticated: Bool { session != nil }

    var displayName: String {
        if let fullName = session?.user.userMetadata["full_name"]?.stringValue,
           !fullName.isEmpty {
            return fullName
        }
        return session?.user.email ?? "Account"
    }

    private let client = SupabaseConfig.client

    init() {
        Task { await listenForAuthChanges() }
    }

    func signUp(fullName: String, email: String, password: String) async throws {
        statusMessage = nil
        let response = try await client.auth.signUp(
            email: email,
            password: password,
            data: ["full_name": .string(fullName)]
        )

        if let session = response.session {
            self.session = session
            return
        }

        // Confirm email is enabled in the Supabase project.
        throw AuthFlowError.emailConfirmationRequired
    }

    func signIn(email: String, password: String) async throws {
        statusMessage = nil
        session = try await client.auth.signIn(email: email, password: password)
    }

    func signOut() async {
        statusMessage = nil
        do {
            try await client.auth.signOut()
            session = nil
        } catch {
            statusMessage = error.localizedDescription
        }
    }

    func clearStatus() {
        statusMessage = nil
    }

    private func listenForAuthChanges() async {
        for await (event, session) in client.auth.authStateChanges {
            guard !Task.isCancelled else { return }

            switch event {
            case .initialSession, .signedIn, .tokenRefreshed, .userUpdated:
                self.session = session
            case .signedOut:
                self.session = nil
            default:
                break
            }

            if event == .initialSession {
                isBootstrapping = false
            }
        }
    }
}
