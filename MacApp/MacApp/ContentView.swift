import SwiftUI
import MetalSplatter
import SplatIO

/// Barebones shell. Replace with real auth + project browsing later.
struct ContentView: View {
    @State private var isLoggedIn = false

    var body: some View {
        Group {
            if isLoggedIn {
                ProjectsPlaceholderView(onSignOut: { isLoggedIn = false })
            } else {
                LoginPlaceholderView(onSignIn: { isLoggedIn = true })
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

private struct LoginPlaceholderView: View {
    var onSignIn: () -> Void

    @State private var email = ""
    @State private var password = ""

    var body: some View {
        VStack(spacing: 20) {
            Text("MacApp")
                .font(.largeTitle.weight(.semibold))

            Text("Barebones login shell — wire this to your backend later.")
                .foregroundStyle(.secondary)

            TextField("Email", text: $email)
                .textFieldStyle(.roundedBorder)
                .frame(maxWidth: 320)

            SecureField("Password", text: $password)
                .textFieldStyle(.roundedBorder)
                .frame(maxWidth: 320)

            Button("Sign In") {
                onSignIn()
            }
            .buttonStyle(.borderedProminent)
            .disabled(email.isEmpty || password.isEmpty)
        }
        .padding(40)
    }
}

private struct ProjectsPlaceholderView: View {
    var onSignOut: () -> Void

    var body: some View {
        NavigationSplitView {
            List {
                Text("Project A")
                Text("Project B")
                Text("Project C")
            }
            .navigationTitle("Projects")
            .toolbar {
                Button("Sign Out", action: onSignOut)
            }
        } detail: {
            VStack(spacing: 12) {
                Text("Splat Viewer Placeholder")
                    .font(.title2.weight(.medium))
                Text("MetalSplatter + SplatIO are linked. Drop a viewer screen here.")
                    .foregroundStyle(.secondary)
                Text("SplatRenderer is available: \(String(describing: SplatRenderer.self))")
                    .font(.caption.monospaced())
                    .foregroundStyle(.tertiary)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }
}

#Preview {
    ContentView()
}
