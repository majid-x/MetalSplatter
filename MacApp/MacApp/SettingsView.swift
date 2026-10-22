import SwiftUI

struct SettingsView: View {
    @Environment(AuthManager.self) private var authManager

    @State private var fullName = ""
    @State private var email = ""

    @State private var isSavingProfile = false
    @State private var isDeleting = false
    @State private var banner: Banner?
    @State private var showPrivacyPolicy = false
    @State private var showDeleteConfirm = false
    @State private var showExactMeasurements = MeasurementDisplayPreferences.showExactMeasurements

    private struct Banner: Equatable {
        enum Kind { case success, error }
        let kind: Kind
        let text: String
    }

    private var profileDirty: Bool {
        let nameChanged = fullName.trimmingCharacters(in: .whitespacesAndNewlines)
            != (authManager.fullName ?? "")
        let emailChanged = email.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
            != (authManager.email ?? "").lowercased()
        return nameChanged || emailChanged
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 28) {
                header

                if let banner {
                    Text(banner.text)
                        .font(.system(size: 13))
                        .foregroundStyle(
                            banner.kind == .success
                                ? Color(red: 0.55, green: 0.82, blue: 0.72)
                                : Color(red: 0.95, green: 0.55, blue: 0.52)
                        )
                        .transition(.opacity)
                }

                profileSection
                measurementSection
                passwordSection
                legalSection
                dangerSection
            }
            .padding(.horizontal, 36)
            .padding(.top, 12)
            .padding(.bottom, 40)
            .frame(maxWidth: 640, alignment: .leading)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .onAppear(perform: hydrateFromSession)
        .onChange(of: authManager.email) { _, _ in
            if !isSavingProfile { hydrateFromSession() }
        }
        .onChange(of: authManager.fullName) { _, _ in
            if !isSavingProfile { hydrateFromSession() }
        }
        .sheet(isPresented: $showPrivacyPolicy) {
            PrivacyPolicyView()
        }
        .confirmationDialog(
            "Delete your account?",
            isPresented: $showDeleteConfirm,
            titleVisibility: .visible
        ) {
            Button("Delete Account", role: .destructive) {
                Task { await deleteAccount() }
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text(
                "This permanently deletes your Vroomk account, project data we store, and local downloads. This cannot be undone."
            )
        }
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Settings")
                .font(.system(size: 40, weight: .ultraLight))
                .foregroundStyle(.white)

            Text("Manage your profile, privacy, and account.")
                .font(.system(size: 14, weight: .regular))
                .foregroundStyle(.white.opacity(0.42))
        }
    }

    private var profileSection: some View {
        settingsCard(title: "Profile", subtitle: "Your name and email for this Vroomk account.") {
            VStack(alignment: .leading, spacing: 14) {
                settingsField(title: "Full name", text: $fullName, prompt: "Your name")
                settingsField(title: "Email", text: $email, prompt: "you@example.com")

                HStack {
                    Button {
                        Task { await saveProfile() }
                    } label: {
                        settingsButtonLabel(
                            title: "Save Profile",
                            busy: isSavingProfile
                        )
                    }
                    .buttonStyle(.plain)
                    .disabled(isSavingProfile || !profileDirty)

                    Spacer()
                }
            }
        }
    }

    private var measurementSection: some View {
        settingsCard(
            title: "Measurements",
            subtitle: "Distances default to feet and inches rounded to the nearest quarter inch."
        ) {
            Toggle(isOn: $showExactMeasurements) {
                VStack(alignment: .leading, spacing: 4) {
                    Text("Show exact measurements")
                        .font(.system(size: 14, weight: .medium))
                        .foregroundStyle(.white)
                    Text(
                        showExactMeasurements
                            ? "Showing finer fractions (1/32″)."
                            : "Rounded to the nearest 1/4″ (e.g. 5′ 3 1/4″)."
                    )
                    .font(.system(size: 12))
                    .foregroundStyle(.white.opacity(0.38))
                }
            }
            .toggleStyle(.switch)
            .tint(Color(red: 0.45, green: 0.82, blue: 0.92))
            .onChange(of: showExactMeasurements) { _, newValue in
                MeasurementDisplayPreferences.showExactMeasurements = newValue
            }
        }
    }

    private var passwordSection: some View {
        settingsCard(
            title: "Password",
            subtitle: "Reset via email code (OTP), then set a new password."
        ) {
            PasswordResetView(
                initialEmail: authManager.email ?? email,
                isPresentedAsSheet: false,
                onFinished: {
                    banner = Banner(kind: .success, text: "Password updated.")
                }
            )
        }
    }

    private var legalSection: some View {
        settingsCard(title: "Privacy & Legal", subtitle: "How Vroomk handles your data.") {
            VStack(alignment: .leading, spacing: 12) {
                Button {
                    showPrivacyPolicy = true
                } label: {
                    rowLabel(title: "Privacy Policy", systemImage: "doc.text")
                }
                .buttonStyle(.plain)

                Link(destination: AppLegal.privacyPolicyURL) {
                    rowLabel(title: "Open Privacy Policy online", systemImage: "safari")
                }

                if let mail = URL(string: "mailto:\(AppLegal.supportEmail)") {
                    Link(destination: mail) {
                        rowLabel(title: "Contact support", systemImage: "envelope")
                    }
                }
            }
        }
    }

    private var dangerSection: some View {
        settingsCard(
            title: "Account",
            subtitle: "Sign out or permanently delete your account."
        ) {
            VStack(alignment: .leading, spacing: 12) {
                Button {
                    Task { await authManager.signOut() }
                } label: {
                    rowLabel(title: "Sign Out", systemImage: "rectangle.portrait.and.arrow.right")
                }
                .buttonStyle(.plain)

                Button(role: .destructive) {
                    showDeleteConfirm = true
                } label: {
                    HStack(spacing: 10) {
                        if isDeleting {
                            ProgressView()
                                .controlSize(.small)
                                .tint(Color(red: 0.95, green: 0.55, blue: 0.52))
                        } else {
                            Image(systemName: "trash")
                                .font(.system(size: 13))
                        }
                        Text("Delete Account")
                            .font(.system(size: 14, weight: .medium))
                        Spacer()
                    }
                    .foregroundStyle(Color(red: 0.95, green: 0.55, blue: 0.52))
                    .padding(.vertical, 8)
                }
                .buttonStyle(.plain)
                .disabled(isDeleting)

                Text("Deleting your account removes your login and project data we control. This cannot be undone.")
                    .font(.system(size: 12))
                    .foregroundStyle(.white.opacity(0.35))
            }
        }
    }

    private func settingsCard<Content: View>(
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

    private func settingsField(title: String, text: Binding<String>, prompt: String) -> some View {
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

    private func settingsButtonLabel(title: String, busy: Bool) -> some View {
        ZStack {
            if busy {
                ProgressView()
                    .controlSize(.small)
                    .tint(.white)
            } else {
                Text(title)
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

    private func rowLabel(title: String, systemImage: String) -> some View {
        HStack(spacing: 10) {
            Image(systemName: systemImage)
                .font(.system(size: 13))
                .frame(width: 18)
            Text(title)
                .font(.system(size: 14, weight: .regular))
            Spacer()
            Image(systemName: "chevron.right")
                .font(.system(size: 11, weight: .semibold))
                .foregroundStyle(.white.opacity(0.25))
        }
        .foregroundStyle(.white.opacity(0.85))
        .padding(.vertical, 8)
        .contentShape(Rectangle())
    }

    private func hydrateFromSession() {
        fullName = authManager.fullName ?? ""
        email = authManager.email ?? ""
    }

    private func saveProfile() async {
        banner = nil
        isSavingProfile = true
        defer { isSavingProfile = false }

        do {
            let trimmedName = fullName.trimmingCharacters(in: .whitespacesAndNewlines)
            let trimmedEmail = email.trimmingCharacters(in: .whitespacesAndNewlines)

            if trimmedName != (authManager.fullName ?? "") {
                try await authManager.updateFullName(trimmedName)
            }
            if trimmedEmail.lowercased() != (authManager.email ?? "").lowercased() {
                try await authManager.updateEmail(trimmedEmail)
            }
            banner = Banner(
                kind: .success,
                text: authManager.statusMessage ?? "Profile updated."
            )
            authManager.clearStatus()
            hydrateFromSession()
        } catch {
            banner = Banner(kind: .error, text: error.localizedDescription)
        }
    }

    private func deleteAccount() async {
        banner = nil
        isDeleting = true
        defer { isDeleting = false }

        do {
            try await authManager.deleteAccount()
        } catch {
            banner = Banner(kind: .error, text: error.localizedDescription)
        }
    }
}

#Preview {
    SettingsView()
        .environment(AuthManager())
        .frame(width: 720, height: 800)
        .background(Color.black)
        .preferredColorScheme(.dark)
}
