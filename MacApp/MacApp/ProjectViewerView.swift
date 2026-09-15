import SwiftUI

/// In-window project viewer: unpacks bundled zip, shows loader, then client scene.
struct ProjectViewerView: View {
    let title: String
    let zipResourceName: String
    var onBack: () -> Void

    private enum Phase: Equatable {
        case unpacking
        case loadingScene
        case ready
        case failed(String)
    }

    @State private var phase: Phase = .unpacking
    @State private var model: ModelIdentifier?
    @State private var pulse = false

    var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()

            if let model, phase == .ready || phase == .loadingScene {
                ClientSceneView(modelIdentifier: model) { ready in
                    if ready {
                        withAnimation(.easeOut(duration: 0.35)) {
                            phase = .ready
                        }
                    }
                }
                .opacity(phase == .ready ? 1 : 0.15)
                .allowsHitTesting(phase == .ready)
            }

            if phase != .ready {
                loaderOverlay
                    .transition(.opacity)
            }

            VStack {
                HStack {
                    Button {
                        onBack()
                    } label: {
                        HStack(spacing: 8) {
                            Image(systemName: "chevron.left")
                                .font(.system(size: 13, weight: .semibold))
                            Text("Projects")
                                .font(.system(size: 13, weight: .medium))
                        }
                        .foregroundStyle(.white)
                        .padding(.horizontal, 14)
                        .padding(.vertical, 9)
                        .background(.ultraThinMaterial, in: Capsule())
                        .overlay {
                            Capsule()
                                .strokeBorder(.white.opacity(0.18), lineWidth: 1)
                        }
                    }
                    .buttonStyle(.plain)

                    Spacer()

                    Text(title)
                        .font(.system(size: 14, weight: .medium))
                        .foregroundStyle(.white.opacity(0.7))
                }
                .padding(.horizontal, 20)
                .padding(.top, 16)

                Spacer()
            }
        }
        .preferredColorScheme(.dark)
        .task {
            await openPackage()
        }
    }

    private var loaderOverlay: some View {
        ZStack {
            LinearGradient(
                colors: [
                    Color(red: 0.04, green: 0.05, blue: 0.07),
                    Color.black,
                    Color(red: 0.06, green: 0.08, blue: 0.10)
                ],
                startPoint: .topLeading,
                endPoint: .bottomTrailing
            )
            .ignoresSafeArea()

            Circle()
                .fill(
                    RadialGradient(
                        colors: [
                            Color(red: 0.25, green: 0.55, blue: 0.65).opacity(0.35),
                            .clear
                        ],
                        center: .center,
                        startRadius: 10,
                        endRadius: 220
                    )
                )
                .frame(width: 420, height: 420)
                .scaleEffect(pulse ? 1.08 : 0.92)
                .blur(radius: 30)

            VStack(spacing: 22) {
                ZStack {
                    Circle()
                        .stroke(.white.opacity(0.08), lineWidth: 2)
                        .frame(width: 64, height: 64)

                    ProgressView()
                        .controlSize(.regular)
                        .tint(.white)
                }

                VStack(spacing: 8) {
                    Text(loaderTitle)
                        .font(.system(size: 22, weight: .ultraLight))
                        .foregroundStyle(.white)

                    Text(loaderSubtitle)
                        .font(.system(size: 13, weight: .regular))
                        .foregroundStyle(.white.opacity(0.45))
                        .multilineTextAlignment(.center)
                }

                if case .failed(let message) = phase {
                    Button("Try Again") {
                        Task { await openPackage() }
                    }
                    .buttonStyle(.borderedProminent)
                    .padding(.top, 8)

                    Text(message)
                        .font(.system(size: 12))
                        .foregroundStyle(Color(red: 0.95, green: 0.55, blue: 0.5))
                        .multilineTextAlignment(.center)
                        .frame(maxWidth: 360)
                }
            }
            .padding(40)
        }
        .onAppear {
            withAnimation(.easeInOut(duration: 1.6).repeatForever(autoreverses: true)) {
                pulse = true
            }
        }
    }

    private var loaderTitle: String {
        switch phase {
        case .unpacking: return "Opening project"
        case .loadingScene: return "Loading scene"
        case .ready: return "Ready"
        case .failed: return "Couldn't open project"
        }
    }

    private var loaderSubtitle: String {
        switch phase {
        case .unpacking:
            return "Unpacking scene package…"
        case .loadingScene:
            return "Building the splat viewer…"
        case .ready:
            return ""
        case .failed:
            return "Check that Archive.zip is bundled with the app."
        }
    }

    private func openPackage() async {
        phase = .unpacking
        model = nil

        guard let zipURL = Bundle.main.url(forResource: zipResourceName, withExtension: "zip") else {
            phase = .failed("Missing \(zipResourceName).zip in app resources.")
            return
        }

        do {
            let package = try await Task.detached(priority: .userInitiated) {
                try ScenePackageLoader.load(from: zipURL)
            }.value

            model = .gaussianSplat(package.modelURL, navigation: package.navigation)
            phase = .loadingScene
        } catch {
            phase = .failed(error.localizedDescription)
        }
    }
}
