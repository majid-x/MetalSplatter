import SwiftUI

/// In-window project viewer: downloads into private app storage, unpacks, then shows the scene.
struct ProjectViewerView: View {
    let project: RemoteProject
    var onBack: () -> Void

    private enum Phase: Equatable {
        case downloading
        case unpacking
        case loadingScene
        case ready
        case failed(String)
    }

    @State private var phase: Phase = .downloading
    @State private var model: ModelIdentifier?
    @State private var pulse = false
    @State private var downloadProgress: ProjectDownloadStore.Progress?

    var body: some View {
        ZStack(alignment: .topLeading) {
            Color.black.ignoresSafeArea()

            if let model, phase == .ready || phase == .loadingScene {
                ClientSceneView(
                    modelIdentifier: model,
                    photoAPIBaseURL: project.photoAPIBaseURL,
                    photoSearchUsesSPZCoordinates: project.isSPZ,
                    photoSearchUsesServerCalibration: project.useServerCalibration,
                    measureCalibrationFactor: project.measureFactor,
                    onModelLoadStateChanged: { ready in
                        if ready {
                            withAnimation(.easeOut(duration: 0.35)) {
                                phase = .ready
                            }
                        }
                    },
                    onModelLoadFailed: { message in
                        withAnimation(.easeOut(duration: 0.25)) {
                            phase = .failed(message)
                        }
                    }
                )
                .opacity(phase == .ready ? 1 : 0.15)
                .allowsHitTesting(phase == .ready)
            }

            if phase != .ready {
                loaderOverlay
                    .transition(.opacity)
            }

            HStack(spacing: 12) {
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

                Text(project.name)
                    .font(.system(size: 14, weight: .medium))
                    .foregroundStyle(.white.opacity(0.7))
                    .lineLimit(1)
                    .allowsHitTesting(false)
            }
            .padding(.horizontal, 20)
            .padding(.top, 16)
        }
        .preferredColorScheme(.dark)
#if os(iOS)
        .onAppear { AppOrientationLock.lockLandscape() }
        .onDisappear { AppOrientationLock.unlockAll() }
#endif
        .task(id: project.id) {
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

                    if case .failed = phase {
                        Image(systemName: "exclamationmark.triangle")
                            .font(.system(size: 22, weight: .light))
                            .foregroundStyle(.white.opacity(0.85))
                    } else if phase == .downloading, downloadProgress?.fraction != nil {
                        EmptyView()
                    } else {
                        ProgressView()
                            .controlSize(.regular)
                            .tint(.white)
                    }
                }

                VStack(spacing: 8) {
                    Text(loaderTitle)
                        .font(.system(size: 22, weight: .ultraLight))
                        .foregroundStyle(.white)

                    Text(loaderSubtitle)
                        .font(.system(size: 13, weight: .regular))
                        .foregroundStyle(.white.opacity(0.45))
                        .multilineTextAlignment(.center)
                        .frame(maxWidth: 360)
                }

                if phase == .downloading {
                    downloadProgressSection
                        .padding(.top, 4)
                }

                if case .failed = phase {
                    Button("Try Again") {
                        Task { await openPackage(forceRedownload: true) }
                    }
                    .buttonStyle(.borderedProminent)
                    .padding(.top, 8)
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

    @ViewBuilder
    private var downloadProgressSection: some View {
        VStack(spacing: 10) {
            if let fraction = downloadProgress?.fraction {
                ProgressView(value: fraction)
                    .progressViewStyle(.linear)
                    .tint(Color(red: 0.35, green: 0.72, blue: 0.85))
                    .frame(maxWidth: 280)
            } else if downloadProgress != nil {
                ProgressView()
                    .progressViewStyle(.linear)
                    .tint(Color(red: 0.35, green: 0.72, blue: 0.85))
                    .frame(maxWidth: 280)
            }

            if let downloadProgress {
                Text(byteProgressLabel(downloadProgress))
                    .font(.system(size: 12, weight: .medium, design: .monospaced))
                    .foregroundStyle(.white.opacity(0.55))
            }
        }
    }

    private var loaderTitle: String {
        switch phase {
        case .downloading: return "Downloading project"
        case .unpacking: return "Preparing project"
        case .loadingScene: return "Loading scene"
        case .ready: return "Ready"
        case .failed: return "Couldn't open project"
        }
    }

    private var loaderSubtitle: String {
        switch phase {
        case .downloading:
            if ProjectDownloadStore.hasCachedPackage(for: project), downloadProgress == nil {
                return "Opening your saved copy…"
            }
            return "Downloading your project…"
        case .unpacking:
            return "Getting everything ready…"
        case .loadingScene:
            return "Almost there…"
        case .ready:
            return ""
        case .failed(let message):
            return message
        }
    }

    private func byteProgressLabel(_ progress: ProjectDownloadStore.Progress) -> String {
        let received = formatBytes(progress.receivedBytes)
        if let total = progress.totalBytes, total > 0 {
            return "\(received) / \(formatBytes(total))"
        }
        return received
    }

    private func formatBytes(_ bytes: Int64) -> String {
        let formatter = ByteCountFormatter()
        formatter.allowedUnits = [.useKB, .useMB, .useGB]
        formatter.countStyle = .file
        formatter.includesUnit = true
        formatter.isAdaptive = true
        return formatter.string(fromByteCount: bytes)
    }

    private func openPackage(forceRedownload: Bool = false) async {
        phase = .downloading
        model = nil
        downloadProgress = nil

        if forceRedownload {
            ProjectDownloadStore.removeCachedPackage(for: project.id)
        }

        do {
            let zipURL = try await ProjectDownloadStore.ensureLocalPackage(for: project) { progress in
                Task { @MainActor in
                    downloadProgress = progress
                }
            }
            let extractDir = try ProjectDownloadStore.extractDirectory(for: project.id)

            phase = .unpacking
            downloadProgress = nil
            let package = try await Task.detached(priority: .userInitiated) {
                try ScenePackageLoader.load(from: zipURL, extractDirectory: extractDir)
            }.value

            model = .gaussianSplat(package.modelURL, navigation: package.navigation)
            phase = .loadingScene
        } catch {
            phase = .failed(friendlyMessage(for: error))
        }
    }

    private func friendlyMessage(for error: Error) -> String {
        if let localized = error as? LocalizedError, let description = localized.errorDescription {
            return description
        }
        let text = error.localizedDescription
        if text.localizedCaseInsensitiveContains("network")
            || text.localizedCaseInsensitiveContains("internet")
            || text.localizedCaseInsensitiveContains("offline")
            || text.localizedCaseInsensitiveContains("timed out") {
            return "Check your connection and try again."
        }
        return "Something went wrong while opening this project. Please try again."
    }
}
