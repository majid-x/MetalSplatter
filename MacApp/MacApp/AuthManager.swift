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

    /// Only clear the local session when the user taps Sign Out — never on auto refresh / expiry.
    private var userInitiatedSignOut = false

    var isAuthenticated: Bool {
        session != nil
    }

    var displayName: String {
        if let fullName = session?.user.userMetadata["full_name"]?.stringValue,
           !fullName.isEmpty {
            return fullName
        }
        return session?.user.email ?? "Account"
    }

    var userId: UUID? {
        session?.user.id
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
        userInitiatedSignOut = true
        do {
            try await client.auth.signOut()
            session = nil
        } catch {
            userInitiatedSignOut = false
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
            case .initialSession:
                await handleInitialSession(session)
            case .signedIn, .tokenRefreshed, .userUpdated:
                if let session {
                    self.session = session
                }
            case .signedOut:
                // Ignore SDK auto-logout (expired token / refresh). Only clear on explicit Sign Out.
                if userInitiatedSignOut {
                    self.session = nil
                    userInitiatedSignOut = false
                }
            default:
                break
            }
        }
    }

    private func handleInitialSession(_ session: Session?) async {
        defer { isBootstrapping = false }

        guard var session else {
            self.session = nil
            return
        }

        // Always keep a restored session so we don't flash the login screen.
        self.session = session

        // Access token may be expired while the refresh token is still valid.
        if session.isExpired {
            do {
                session = try await client.auth.refreshSession()
                self.session = session
            } catch {
                // Keep the restored session; next API call / token refresh can recover.
                // Do not force the user back to login.
            }
        }
    }
}
