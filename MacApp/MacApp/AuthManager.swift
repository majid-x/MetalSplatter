import Foundation
import Observation
import Supabase

enum AuthFlowError: LocalizedError {
    case emailConfirmationRequired
    case invalidCredentials
    case notSignedIn
    case message(String)

    var errorDescription: String? {
        switch self {
        case .emailConfirmationRequired:
            return "Check your email to confirm your account, then sign in."
        case .invalidCredentials:
            return "Invalid email or password."
        case .notSignedIn:
            return "You need to be signed in to continue."
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
        if let fullName = fullName, !fullName.isEmpty {
            return fullName
        }
        return email ?? "Account"
    }

    var fullName: String? {
        session?.user.userMetadata["full_name"]?.stringValue
    }

    var email: String? {
        session?.user.email
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

    func updateFullName(_ name: String) async throws {
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.count >= 2 else {
            throw AuthFlowError.message("Name must be at least 2 characters.")
        }
        guard session != nil else { throw AuthFlowError.notSignedIn }

        let user = try await client.auth.update(
            user: UserAttributes(data: ["full_name": .string(trimmed)])
        )
        applyUpdatedUser(user)
        statusMessage = "Name updated."
    }

    /// Updates email. Supabase may require the user to confirm the new address.
    func updateEmail(_ newEmail: String) async throws {
        let trimmed = newEmail.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard trimmed.contains("@"), trimmed.contains(".") else {
            throw AuthFlowError.message("Enter a valid email address.")
        }
        guard session != nil else { throw AuthFlowError.notSignedIn }

        if trimmed == email?.lowercased() {
            throw AuthFlowError.message("That's already your email.")
        }

        let user = try await client.auth.update(user: UserAttributes(email: trimmed))
        applyUpdatedUser(user)
        statusMessage = "Check \(trimmed) to confirm your new email."
    }

    // MARK: - Password reset (Azure OTP API)

    func sendPasswordResetOTP(email: String) async throws {
        let trimmed = email.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard trimmed.contains("@") else {
            throw AuthFlowError.message("Enter a valid email address.")
        }
        do {
            try await AccountAPIClient.sendPasswordResetOTP(email: trimmed)
            statusMessage = "Check \(trimmed) for a one-time code."
        } catch {
            throw AuthFlowError.message(error.localizedDescription)
        }
    }

    func verifyPasswordResetOTP(email: String, otp: String) async throws -> String {
        let trimmedEmail = email.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        let trimmedOTP = otp.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedOTP.isEmpty else {
            throw AuthFlowError.message("Enter the code from your email.")
        }
        do {
            return try await AccountAPIClient.verifyPasswordResetOTP(
                email: trimmedEmail,
                otp: trimmedOTP
            )
        } catch {
            throw AuthFlowError.message(error.localizedDescription)
        }
    }

    func setPasswordWithResetSecret(
        email: String,
        secret: String,
        newPassword: String
    ) async throws {
        let trimmedEmail = email.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard newPassword.count >= 6 else {
            throw AuthFlowError.message("Password must be at least 6 characters.")
        }
        do {
            try await AccountAPIClient.setPassword(
                email: trimmedEmail,
                secret: secret,
                newPassword: newPassword
            )
            statusMessage = "Password updated."
        } catch {
            throw AuthFlowError.message(error.localizedDescription)
        }
    }

    /// Deletes account via Azure API, then clears local session/caches.
    func deleteAccount() async throws {
        guard let session else {
            throw AuthFlowError.notSignedIn
        }

        statusMessage = nil
        ProjectDownloadStore.removeAllCachedPackages()

        do {
            try await AccountAPIClient.deleteAccount(accessToken: session.accessToken)
        } catch {
            throw AuthFlowError.message(
                "Couldn't delete account: \(error.localizedDescription)"
            )
        }

        userInitiatedSignOut = true
        self.session = nil
        do {
            try await client.auth.signOut()
        } catch {
            // Local session already cleared.
        }
    }

    func clearStatus() {
        statusMessage = nil
    }

    private func applyUpdatedUser(_ user: User) {
        guard var session else { return }
        session.user = user
        self.session = session
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
