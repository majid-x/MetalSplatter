import SwiftUI

struct ContentView: View {
    @Environment(AuthManager.self) private var authManager

    var body: some View {
        Group {
            if authManager.isBootstrapping {
                ZStack {
                    Color.black.ignoresSafeArea()
                    ProgressView()
                        .controlSize(.regular)
                        .tint(.white)
                }
            } else if authManager.isAuthenticated {
                DashboardView()
            } else {
                AuthView()
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

// MARK: - Auth

private enum AuthMode {
    case signIn
    case signUp

    var title: String {
        switch self {
        case .signIn: return "Welcome Back"
        case .signUp: return "Create Account"
        }
    }

    var actionLabel: String {
        switch self {
        case .signIn: return "Login"
        case .signUp: return "Signup"
        }
    }

    var footerPrompt: String {
        switch self {
        case .signIn: return "Don't have an account?"
        case .signUp: return "Already have an account?"
        }
    }

    var footerAction: String {
        switch self {
        case .signIn: return "Signup"
        case .signUp: return "Login"
        }
    }
}

private enum AuthFieldFocus: Hashable {
    case fullName, email, password, confirm
}

private struct AuthView: View {
    @Environment(AuthManager.self) private var authManager

    @State private var mode: AuthMode = .signIn
    @State private var fullName = ""
    @State private var email = ""
    @State private var password = ""
    @State private var confirmPassword = ""
    @State private var attemptedSubmit = false
    @State private var isSubmitting = false
    @State private var formError: String?
    @State private var infoMessage: String?
    @State private var ambientPhase: CGFloat = 0
    @FocusState private var focusedField: AuthFieldFocus?

    private var trimmedName: String {
        fullName.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private var trimmedEmail: String {
        email.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private var emailValid: Bool {
        let trimmed = trimmedEmail
        guard let at = trimmed.firstIndex(of: "@"),
              at > trimmed.startIndex,
              let dot = trimmed[trimmed.index(after: at)...].lastIndex(of: "."),
              trimmed.distance(from: dot, to: trimmed.endIndex) > 1
        else { return false }
        return !trimmed.contains(" ")
    }

    private var nameValid: Bool {
        trimmedName.count >= 2
    }

    private var passwordValid: Bool {
        mode == .signIn ? !password.isEmpty : password.count >= 8
    }

    private var confirmValid: Bool {
        !confirmPassword.isEmpty && confirmPassword == password
    }

    private var canSubmit: Bool {
        guard emailValid, passwordValid else { return false }
        if mode == .signUp {
            return nameValid && confirmValid
        }
        return true
    }

    var body: some View {
        ZStack {
            AuthAtmosphere(phase: ambientPhase)
                .ignoresSafeArea()

            VStack {
                HStack {
                    BrandMark()
                        .frame(width: 36, height: 36)
                        .padding(.leading, 28)
                        .padding(.top, 24)
                    Spacer()
                }
                Spacer()
            }

            VStack(spacing: 0) {
                Spacer(minLength: 40)

                VStack(spacing: 28) {
                    Text(mode.title)
                        .font(.system(size: 36, weight: .ultraLight))
                        .foregroundStyle(.white)
                        .tracking(-0.4)
                        .contentTransition(.opacity)
                        .id(mode.title)

                    VStack(spacing: 14) {
                        if mode == .signUp {
                            GlassPillField(
                                placeholder: "Enter your full name",
                                text: $fullName,
                                isSecure: false,
                                isValid: !attemptedSubmit || nameValid,
                                focus: $focusedField,
                                field: .fullName,
                                contentType: .name
                            )
                            .transition(.asymmetric(
                                insertion: .opacity.combined(with: .move(edge: .top)),
                                removal: .opacity
                            ))
                        }

                        GlassPillField(
                            placeholder: "Enter your email address",
                            text: $email,
                            isSecure: false,
                            isValid: !attemptedSubmit || emailValid,
                            focus: $focusedField,
                            field: .email,
                            contentType: .username
                        )

                        GlassPillField(
                            placeholder: "Enter your password",
                            text: $password,
                            isSecure: true,
                            isValid: !attemptedSubmit || passwordValid,
                            focus: $focusedField,
                            field: .password,
                            contentType: mode == .signUp ? .newPassword : .password
                        )

                        if mode == .signUp {
                            GlassPillField(
                                placeholder: "Confirm your password",
                                text: $confirmPassword,
                                isSecure: true,
                                isValid: !attemptedSubmit || confirmValid,
                                focus: $focusedField,
                                field: .confirm,
                                contentType: .newPassword
                            )
                            .transition(.asymmetric(
                                insertion: .opacity.combined(with: .move(edge: .top)),
                                removal: .opacity
                            ))
                        }

                        if let formError {
                            Text(formError)
                                .font(.system(size: 12, weight: .regular))
                                .foregroundStyle(Color(red: 0.95, green: 0.55, blue: 0.52))
                                .multilineTextAlignment(.center)
                                .transition(.opacity)
                        } else if let infoMessage {
                            Text(infoMessage)
                                .font(.system(size: 12, weight: .regular))
                                .foregroundStyle(Color(red: 0.55, green: 0.82, blue: 0.72))
                                .multilineTextAlignment(.center)
                                .transition(.opacity)
                        }
                    }
                    .animation(.spring(response: 0.4, dampingFraction: 0.86), value: mode)

                    Button {
                        Task { await submit() }
                    } label: {
                        ZStack {
                            if isSubmitting {
                                ProgressView()
                                    .controlSize(.small)
                                    .tint(.white)
                            } else {
                                Text(mode.actionLabel)
                                    .font(.system(size: 15, weight: .regular))
                                    .foregroundStyle(.white)
                            }
                        }
                        .frame(width: 168, height: 44)
                        .background {
                            Capsule()
                                .fill(.white.opacity(0.10))
                                .background(.ultraThinMaterial, in: Capsule())
                                .overlay {
                                    Capsule()
                                        .strokeBorder(.white.opacity(0.18), lineWidth: 1)
                                }
                        }
                    }
                    .buttonStyle(AuthPressStyle())
                    .disabled(isSubmitting)
                    .padding(.top, 4)

                    HStack(spacing: 6) {
                        Text(mode.footerPrompt)
                            .foregroundStyle(.white.opacity(0.38))
                        Button(mode.footerAction) {
                            withAnimation(.spring(response: 0.4, dampingFraction: 0.86)) {
                                mode = mode == .signIn ? .signUp : .signIn
                                attemptedSubmit = false
                                formError = nil
                                infoMessage = nil
                                confirmPassword = ""
                                focusedField = mode == .signUp ? .fullName : .email
                            }
                        }
                        .buttonStyle(.plain)
                        .foregroundStyle(.white.opacity(0.72))
                    }
                    .font(.system(size: 13, weight: .regular))
                    .padding(.top, 8)
                }
                .frame(maxWidth: 420)
                .padding(.horizontal, 36)

                Spacer(minLength: 40)
            }
        }
        .preferredColorScheme(.dark)
        .animation(.easeInOut(duration: 0.25), value: mode)
        .onAppear {
            withAnimation(.easeInOut(duration: 14).repeatForever(autoreverses: true)) {
                ambientPhase = 1
            }
        }
    }

    private func submit() async {
        attemptedSubmit = true
        formError = nil
        infoMessage = nil

        guard canSubmit else {
            formError = validationMessage
            return
        }

        isSubmitting = true
        defer { isSubmitting = false }

        do {
            switch mode {
            case .signIn:
                try await authManager.signIn(email: trimmedEmail, password: password)
            case .signUp:
                try await authManager.signUp(
                    fullName: trimmedName,
                    email: trimmedEmail,
                    password: password
                )
            }
        } catch let error as AuthFlowError {
            switch error {
            case .emailConfirmationRequired:
                infoMessage = error.localizedDescription
                withAnimation(.spring(response: 0.4, dampingFraction: 0.86)) {
                    mode = .signIn
                }
            default:
                formError = error.localizedDescription
            }
        } catch {
            formError = friendlyMessage(for: error)
        }
    }

    private var validationMessage: String {
        if mode == .signUp && !nameValid { return "Enter your full name" }
        if !emailValid { return "Enter a valid email address" }
        if !passwordValid {
            return mode == .signUp ? "Password must be at least 8 characters" : "Password is required"
        }
        if mode == .signUp && !confirmValid { return "Passwords must match" }
        return "Please check your details"
    }

    private func friendlyMessage(for error: Error) -> String {
        let text = error.localizedDescription
        if text.localizedCaseInsensitiveContains("invalid login")
            || text.localizedCaseInsensitiveContains("invalid credentials") {
            return AuthFlowError.invalidCredentials.localizedDescription
        }
        if text.localizedCaseInsensitiveContains("already registered")
            || text.localizedCaseInsensitiveContains("user already") {
            return "An account with this email already exists. Try logging in."
        }
        return text
    }
}

// MARK: - Pill Field

private struct GlassPillField: View {
    let placeholder: String
    @Binding var text: String
    var isSecure: Bool
    var isValid: Bool
    var focus: FocusState<AuthFieldFocus?>.Binding
    var field: AuthFieldFocus
    var contentType: NSTextContentType? = nil

    @State private var reveal = false

    var body: some View {
        HStack(spacing: 10) {
            Group {
                if isSecure && !reveal {
                    SecureField("", text: $text, prompt: prompt)
                } else {
                    TextField("", text: $text, prompt: prompt)
                }
            }
            .textFieldStyle(.plain)
            .font(.system(size: 14, weight: .regular))
            .foregroundStyle(.white.opacity(0.92))
            .focused(focus, equals: field)
            .textContentType(contentType)

            if isSecure {
                Button {
                    reveal.toggle()
                } label: {
                    Image(systemName: reveal ? "eye.slash" : "eye")
                        .font(.system(size: 12, weight: .regular))
                        .foregroundStyle(.white.opacity(0.35))
                }
                .buttonStyle(.plain)
            }
        }
        .padding(.horizontal, 22)
        .frame(height: 50)
        .background {
            Capsule()
                .fill(.white.opacity(0.06))
                .background(.ultraThinMaterial.opacity(0.55), in: Capsule())
                .overlay {
                    Capsule()
                        .strokeBorder(
                            isValid ? Color.white.opacity(0.16) : Color(red: 0.95, green: 0.45, blue: 0.42).opacity(0.65),
                            lineWidth: 1
                        )
                }
        }
    }

    private var prompt: Text {
        Text(placeholder).foregroundStyle(.white.opacity(0.32))
    }
}

private struct AuthPressStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .scaleEffect(configuration.isPressed ? 0.97 : 1)
            .opacity(configuration.isPressed ? 0.88 : 1)
            .animation(.easeOut(duration: 0.15), value: configuration.isPressed)
    }
}

// MARK: - Atmosphere

private struct AuthAtmosphere: View {
    var phase: CGFloat

    var body: some View {
        GeometryReader { geo in
            let w = geo.size.width
            let h = geo.size.height

            ZStack {
                Color.black

                Ellipse()
                    .fill(
                        RadialGradient(
                            colors: [
                                Color.white.opacity(0.55),
                                Color(red: 0.55, green: 0.78, blue: 0.95).opacity(0.28),
                                .clear
                            ],
                            center: .center,
                            startRadius: 4,
                            endRadius: 220
                        )
                    )
                    .frame(width: w * 1.4, height: 180)
                    .rotationEffect(.degrees(-28 + Double(phase) * 6))
                    .offset(x: w * 0.05, y: -h * 0.08 + phase * 30)
                    .blur(radius: 48)

                Ellipse()
                    .fill(
                        RadialGradient(
                            colors: [
                                Color(red: 0.70, green: 0.85, blue: 1.0).opacity(0.35),
                                Color(red: 0.45, green: 0.55, blue: 0.75).opacity(0.12),
                                .clear
                            ],
                            center: .center,
                            startRadius: 2,
                            endRadius: 180
                        )
                    )
                    .frame(width: w * 1.1, height: 140)
                    .rotationEffect(.degrees(18 - Double(phase) * 8))
                    .offset(x: -w * 0.12, y: h * 0.12 - phase * 40)
                    .blur(radius: 56)

                Ellipse()
                    .fill(
                        RadialGradient(
                            colors: [
                                Color.white.opacity(0.18),
                                .clear
                            ],
                            center: .center,
                            startRadius: 10,
                            endRadius: 200
                        )
                    )
                    .frame(width: 420, height: 260)
                    .offset(x: w * 0.2, y: h * 0.28)
                    .blur(radius: 70)

                Rectangle()
                    .fill(
                        RadialGradient(
                            colors: [.clear, .black.opacity(0.55)],
                            center: .center,
                            startRadius: min(w, h) * 0.2,
                            endRadius: max(w, h) * 0.72
                        )
                    )
            }
            .frame(width: w, height: h)
        }
    }
}

#Preview {
    ContentView()
        .environment(AuthManager())
}
