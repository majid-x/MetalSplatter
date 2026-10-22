import SwiftUI

/// Shared 3-step OTP password reset / change flow (Azure API).
struct PasswordResetView: View {
    @Environment(AuthManager.self) private var authManager
    @Environment(\.dismiss) private var dismiss

    var initialEmail: String = ""
    var isPresentedAsSheet: Bool = true
    var onFinished: (() -> Void)? = nil

    private enum Step: Int {
        case email = 0
        case otp = 1
        case password = 2
    }

    @State private var step: Step = .email
    @State private var email = ""
    @State private var otp = ""
    @State private var secret = ""
    @State private var newPassword = ""
    @State private var confirmPassword = ""
    @State private var isBusy = false
    @State private var errorText: String?
    @State private var infoText: String?

    private var emailValid: Bool {
        let trimmed = email.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let at = trimmed.firstIndex(of: "@"),
              at > trimmed.startIndex,
              let dot = trimmed[trimmed.index(after: at)...].lastIndex(of: "."),
              trimmed.distance(from: dot, to: trimmed.endIndex) > 1
        else { return false }
        return !trimmed.contains(" ")
    }

    private var passwordValid: Bool {
        newPassword.count >= 6 && newPassword == confirmPassword
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            if isPresentedAsSheet {
                HStack {
                    Text("Reset Password")
                        .font(.system(size: 18, weight: .medium))
                        .foregroundStyle(.white)
                    Spacer()
                    Button("Close") { dismiss() }
                }
                .padding(.horizontal, 24)
                .padding(.vertical, 18)

                Divider().overlay(.white.opacity(0.08))
            }

            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    Text(stepSubtitle)
                        .font(.system(size: 13))
                        .foregroundStyle(.white.opacity(0.42))

                    switch step {
                    case .email:
                        field(title: "Email", text: $email, prompt: "you@example.com", secure: false)
                    case .otp:
                        field(title: "Email", text: $email, prompt: "you@example.com", secure: false)
                            .disabled(true)
                            .opacity(0.7)
                        field(title: "One-time code", text: $otp, prompt: "123456", secure: false)
                    case .password:
                        secureField(title: "New password", text: $newPassword)
                        secureField(title: "Confirm password", text: $confirmPassword)
                    }

                    if let errorText {
                        Text(errorText)
                            .font(.system(size: 12))
                            .foregroundStyle(Color(red: 0.95, green: 0.55, blue: 0.52))
                    } else if let infoText {
                        Text(infoText)
                            .font(.system(size: 12))
                            .foregroundStyle(Color(red: 0.55, green: 0.82, blue: 0.72))
                    }

                    Button {
                        Task { await advance() }
                    } label: {
                        ZStack {
                            if isBusy {
                                ProgressView().controlSize(.small).tint(.white)
                            } else {
                                Text(primaryButtonTitle)
                                    .font(.system(size: 13, weight: .medium))
                                    .foregroundStyle(.white)
                            }
                        }
                        .frame(height: 36)
                        .padding(.horizontal, 16)
                        .background {
                            Capsule()
                                .fill(.white.opacity(0.10))
                                .overlay {
                                    Capsule().strokeBorder(.white.opacity(0.16), lineWidth: 1)
                                }
                        }
                    }
                    .buttonStyle(.plain)
                    .disabled(isBusy || !canAdvance)

                    if step != .email {
                        Button("Back") {
                            errorText = nil
                            infoText = nil
                            withAnimation(.easeOut(duration: 0.2)) {
                                step = Step(rawValue: max(0, step.rawValue - 1)) ?? .email
                            }
                        }
                        .buttonStyle(.plain)
                        .font(.system(size: 12))
                        .foregroundStyle(.white.opacity(0.45))
                    }
                }
                .padding(24)
            }
        }
        .frame(minWidth: isPresentedAsSheet ? 420 : nil, minHeight: isPresentedAsSheet ? 360 : nil)
        .background(Color.black)
        .preferredColorScheme(.dark)
        .onAppear {
            if email.isEmpty {
                email = initialEmail
            }
        }
    }

    private var stepSubtitle: String {
        switch step {
        case .email:
            return "We'll email a one-time code (valid 10 minutes)."
        case .otp:
            return "Enter the code from your email."
        case .password:
            return "Choose a new password (at least 6 characters)."
        }
    }

    private var primaryButtonTitle: String {
        switch step {
        case .email: return "Send Code"
        case .otp: return "Verify Code"
        case .password: return "Set Password"
        }
    }

    private var canAdvance: Bool {
        switch step {
        case .email: return emailValid
        case .otp: return emailValid && !otp.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        case .password: return passwordValid
        }
    }

    private func field(title: String, text: Binding<String>, prompt: String, secure: Bool) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title)
                .font(.system(size: 12, weight: .medium))
                .foregroundStyle(.white.opacity(0.45))
            Group {
                if secure {
                    SecureField(prompt, text: text)
                } else {
                    TextField(prompt, text: text)
                }
            }
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

    private func secureField(title: String, text: Binding<String>) -> some View {
        field(title: title, text: text, prompt: "••••••••", secure: true)
    }

    private func advance() async {
        errorText = nil
        infoText = nil
        isBusy = true
        defer { isBusy = false }

        do {
            switch step {
            case .email:
                try await authManager.sendPasswordResetOTP(email: email)
                infoText = authManager.statusMessage
                authManager.clearStatus()
                withAnimation(.easeOut(duration: 0.2)) { step = .otp }
            case .otp:
                secret = try await authManager.verifyPasswordResetOTP(email: email, otp: otp)
                infoText = "Code verified. Set your new password."
                withAnimation(.easeOut(duration: 0.2)) { step = .password }
            case .password:
                guard passwordValid else {
                    errorText = "Passwords must match and be at least 6 characters."
                    return
                }
                try await authManager.setPasswordWithResetSecret(
                    email: email,
                    secret: secret,
                    newPassword: newPassword
                )
                infoText = "Password updated. You can sign in with the new password."
                authManager.clearStatus()
                onFinished?()
                if isPresentedAsSheet {
                    dismiss()
                }
            }
        } catch {
            errorText = error.localizedDescription
        }
    }
}
