import SwiftUI
import MetalKit
import CoreGraphics
import UniformTypeIdentifiers

#if os(macOS)
import AppKit
private typealias PlatformViewRepresentable = NSViewRepresentable
#elseif os(iOS) || os(visionOS)
import UIKit
private typealias PlatformViewRepresentable = UIViewRepresentable
#endif

/// Client splat viewer: Point Click + Search Products (macOS / iOS / visionOS).
struct ClientSceneView: View {
    var modelIdentifier: ModelIdentifier?
    /// From project `photo_api`. Nil hides Point Click / photo search.
    var photoAPIBaseURL: URL? = nil
    /// From project `spz`. Inverted: false = send display as-is; true = apply 180° Z undo.
    var photoSearchUsesSPZCoordinates: Bool = false
    /// From project `calibration`. True → PlayCanvas server-calibration (raw display coords).
    var photoSearchUsesServerCalibration: Bool = false
    /// From project `measur_factor`. Scales Measure tool distances (`display = raw * factor`).
    var measureCalibrationFactor: Float = 1.0
    var onModelLoadStateChanged: ((Bool) -> Void)? = nil
    var onModelLoadFailed: ((String) -> Void)? = nil

    @State private var rendererBox = ClientRendererBox()
    @State private var pointClickMode = false
    @State private var pointClickStatus = "Search Image off"
    @State private var searchedPhotos: [PhotoSearchResult] = []
    @State private var isPhotoSearching = false
    @State private var hasMorePhotos = false
    @State private var isFetchingMorePhotos = false
    @State private var showPhotoPanel = false

    @State private var measureMode = false
    @State private var measureStatus = "Measure off"
    @State private var measureDeleteMode = false
    @State private var measureLabelOverlays: [MetalKitSceneRenderer.MeasureLabelOverlay] = []

    @State private var isSelectingScreenshot = false
    @State private var screenshotSelectionPurpose: ScreenshotSelectionPurpose = .productSearch
    @State private var showProductPanel = false
    @State private var productMatches: [ProductSearchMatch] = []
    @State private var productPreview: PlatformImage?
    @State private var isProductSearching = false
    @State private var productStatusText = "Take a screenshot to search visual matches."
    @State private var productSearchTask: Task<Void, Never>?
    @State private var productSearchClient = ProductSearchClient()
    @State private var isSavingScreenshot = false
    @State private var toolHintOverride: String?
#if os(iOS) || os(visionOS)
    @State private var shareScreenshotURL: URL?
    @State private var isSharePresented = false
#endif

    private enum ScreenshotSelectionPurpose {
        case productSearch
        case saveToDisk
    }

    private var controlHint: String {
        if let toolHintOverride { return toolHintOverride }
        if isSelectingScreenshot {
#if os(macOS)
            return "Drag to select an area · Esc or tap tool again to cancel"
#else
            return "Drag to select an area · tap the tool again to cancel"
#endif
        }
        if measureMode {
#if os(macOS)
            return "Measure on · click two points for a distance · drag to look · Delete / Undo"
#else
            return "Measure on · tap two points for a distance · drag to look · Delete / Undo"
#endif
        }
        if pointClickMode {
#if os(macOS)
            return "Search Image on · click a surface to search · drag to look · tap tool again to leave"
#else
            return "Search Image on · tap a surface to search · drag to look · tap tool again to leave"
#endif
        }
#if os(macOS)
        return "Click to look · mouse looks around · WASD/arrows move · Esc releases cursor"
#else
        return "Drag to look · use the pad to move"
#endif
    }

    private var supportsPhotoSearch: Bool { photoAPIBaseURL != nil }

    var body: some View {
        HStack(spacing: 0) {
            ZStack(alignment: .bottomLeading) {
                ClientSceneRepresentable(
                    modelIdentifier: modelIdentifier,
                    photoAPIBaseURL: photoAPIBaseURL,
                    photoSearchUsesSPZCoordinates: photoSearchUsesSPZCoordinates,
                    photoSearchUsesServerCalibration: photoSearchUsesServerCalibration,
                    measureCalibrationFactor: measureCalibrationFactor,
                    rendererBox: rendererBox,
                    onPointClickStateChanged: {
                        pointClickMode = rendererBox.renderer?.pointClickMode ?? false
                        pointClickStatus = rendererBox.renderer?.pointClickStatus ?? "Search Image off"
                        searchedPhotos = rendererBox.renderer?.searchedPhotos ?? []
                        isPhotoSearching = rendererBox.renderer?.isPhotoSearching ?? false
                        hasMorePhotos = rendererBox.renderer?.hasMorePhotos ?? false
                        isFetchingMorePhotos = rendererBox.renderer?.isFetchingMorePhotos ?? false
                        if isPhotoSearching || !searchedPhotos.isEmpty {
                            showPhotoPanel = true
                        }
                    },
                    onMeasureStateChanged: {
                        measureMode = rendererBox.renderer?.measureMode ?? false
                        measureStatus = rendererBox.renderer?.measureStatus ?? "Measure off"
                        measureDeleteMode = rendererBox.renderer?.measureDeleteMode ?? false
                        measureLabelOverlays = rendererBox.renderer?.measureLabelOverlays ?? []
                    },
                    onModelLoadStateChanged: onModelLoadStateChanged,
                    onModelLoadFailed: onModelLoadFailed
                )
                .frame(maxWidth: .infinity, maxHeight: .infinity)

                // Mid-segment distance labels (PlayCanvas measurer text).
                ForEach(measureLabelOverlays) { label in
                    Text(label.text)
                        .font(.system(size: 12, weight: .semibold, design: .monospaced))
                        .foregroundStyle(Color(red: 0.2, green: 0.95, blue: 1.0))
                        .padding(.horizontal, 8)
                        .padding(.vertical, 4)
                        .background(Color.black.opacity(0.55), in: Capsule())
                        .position(label.viewPoint)
                        .allowsHitTesting(false)
                }

                VStack(alignment: .leading, spacing: 8) {
                    VStack(alignment: .leading, spacing: 6) {
                        if supportsPhotoSearch {
                            ViewerToolButton(
                                title: pointClickMode ? "Search Image On" : "Search Image",
                                systemImage: "hand.tap",
                                isActive: pointClickMode,
                                accent: Color(red: 1.0, green: 0.55, blue: 0.22),
                                isDisabled: (isSelectingScreenshot && !pointClickMode) || isSavingScreenshot || measureMode
                            ) {
                                let enabled = !pointClickMode
#if os(macOS)
                                rendererBox.cameraView?.setMouseLookActive(false)
#endif
                                if enabled {
                                    cancelScreenshotSelection()
                                    rendererBox.renderer?.setMeasureMode(false)
                                    measureMode = false
                                }
                                rendererBox.renderer?.setPointClickMode(enabled)
                                pointClickMode = enabled
                                pointClickStatus = rendererBox.renderer?.pointClickStatus ?? pointClickStatus
                                if !enabled {
                                    showPhotoPanel = false
                                    searchedPhotos = []
                                    isPhotoSearching = false
                                    hasMorePhotos = false
                                    isFetchingMorePhotos = false
                                }
                            }
                        }

                        ViewerToolButton(
                            title: measureMode ? "Measure On" : "Measure",
                            systemImage: "ruler",
                            isActive: measureMode,
                            accent: Color(red: 0.2, green: 0.85, blue: 0.95),
                            isDisabled: (isSelectingScreenshot && !measureMode) || isSavingScreenshot
                        ) {
                            let enabled = !measureMode
#if os(macOS)
                            rendererBox.cameraView?.setMouseLookActive(false)
#endif
                            if enabled {
                                cancelScreenshotSelection()
                                if pointClickMode {
                                    rendererBox.renderer?.setPointClickMode(false)
                                    pointClickMode = false
                                    showPhotoPanel = false
                                }
                            }
                            rendererBox.renderer?.setMeasureMode(enabled)
                            measureMode = enabled
                            measureStatus = rendererBox.renderer?.measureStatus ?? measureStatus
                            measureDeleteMode = false
                        }

                        if measureMode {
                            HStack(spacing: 6) {
                                MeasureSubButton(
                                    title: "Delete",
                                    systemImage: "trash",
                                    isActive: measureDeleteMode,
                                    accent: Color(red: 1.0, green: 0.35, blue: 0.35)
                                ) {
                                    let next = !measureDeleteMode
                                    rendererBox.renderer?.setMeasureDeleteMode(next)
                                    measureDeleteMode = next
                                    measureStatus = rendererBox.renderer?.measureStatus ?? measureStatus
                                }
                                MeasureSubButton(title: "Undo", systemImage: "arrow.uturn.backward", isActive: false, accent: .white) {
                                    _ = rendererBox.renderer?.undoMeasurePoint()
                                    measureStatus = rendererBox.renderer?.measureStatus ?? measureStatus
                                    measureLabelOverlays = rendererBox.renderer?.measureLabelOverlays ?? []
                                }
                            }
                        }

                        ViewerToolButton(
                            title: "Search Products",
                            systemImage: "bag",
                            isActive: (isSelectingScreenshot && screenshotSelectionPurpose == .productSearch)
                                || isProductSearching
                                || showProductPanel,
                            accent: Color(red: 0.22, green: 0.52, blue: 1.0),
                            isDisabled: isProductSearching
                                || isSavingScreenshot
                                || (isSelectingScreenshot && screenshotSelectionPurpose != .productSearch)
                        ) {
                            if isSelectingScreenshot && screenshotSelectionPurpose == .productSearch {
                                cancelScreenshotSelection()
                            } else {
                                beginScreenshotSelection(purpose: .productSearch)
                            }
                        }

                        ViewerToolButton(
                            title: isSavingScreenshot ? "Saving…" : "Screenshot",
                            systemImage: "camera",
                            isActive: (isSelectingScreenshot && screenshotSelectionPurpose == .saveToDisk)
                                || isSavingScreenshot,
                            accent: Color(red: 0.25, green: 0.78, blue: 0.55),
                            isDisabled: isSavingScreenshot
                                || (isSelectingScreenshot && screenshotSelectionPurpose != .saveToDisk)
                        ) {
                            if isSelectingScreenshot && screenshotSelectionPurpose == .saveToDisk {
                                cancelScreenshotSelection()
                            } else {
                                beginScreenshotSelection(purpose: .saveToDisk)
                            }
                        }
                    }

                    if measureMode || measureStatus != "Measure off" {
                        Text(measureStatus)
                            .font(.system(size: 11, design: .monospaced))
                            .foregroundStyle(.white)
                            .padding(.horizontal, 12)
                            .padding(.vertical, 8)
                            .background(Color(red: 0.08, green: 0.09, blue: 0.12), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                            .overlay {
                                RoundedRectangle(cornerRadius: 10, style: .continuous)
                                    .strokeBorder(.white.opacity(0.18), lineWidth: 1)
                            }
                    }

                    if supportsPhotoSearch && (pointClickMode || pointClickStatus != "Search Image off") {
                        Text(pointClickStatus)
                            .font(.system(size: 11, design: .monospaced))
                            .foregroundStyle(.white)
                            .padding(.horizontal, 12)
                            .padding(.vertical, 8)
                            .background(Color(red: 0.08, green: 0.09, blue: 0.12), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                            .overlay {
                                RoundedRectangle(cornerRadius: 10, style: .continuous)
                                    .strokeBorder(.white.opacity(0.18), lineWidth: 1)
                            }
                    }

                    Text(controlHint)
                        .font(.system(size: 11, weight: .medium))
                        .foregroundStyle(.white.opacity(0.9))
                        .padding(.horizontal, 12)
                        .padding(.vertical, 8)
                        .background(Color(red: 0.08, green: 0.09, blue: 0.12), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                        .overlay {
                            RoundedRectangle(cornerRadius: 10, style: .continuous)
                                .strokeBorder(.white.opacity(0.18), lineWidth: 1)
                        }
                }
                .padding(.leading, 16)
                .padding(.bottom, 16)

                if isSelectingScreenshot {
                    ScreenshotSelectionOverlay(
                        onComplete: { rect, overlaySize in
                            let purpose = screenshotSelectionPurpose
                            isSelectingScreenshot = false
                            switch purpose {
                            case .productSearch:
                                Task { await captureAndSearchProducts(selection: rect, overlaySize: overlaySize) }
                            case .saveToDisk:
                                Task { await captureAndSaveScreenshot(selection: rect, overlaySize: overlaySize) }
                            }
                        },
                        onCancel: {
                            isSelectingScreenshot = false
                            toolHintOverride = nil
                        }
                    )
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                }
            }

            if showProductPanel {
                Divider()
                ProductSearchSidePanel(
                    matches: productMatches,
                    isLoading: isProductSearching,
                    statusText: productStatusText,
                    onClose: {
                        showProductPanel = false
                        productSearchTask?.cancel()
                        productSearchTask = nil
                        isProductSearching = false
                        productPreview = nil
                        productMatches = []
                    }
                )
            } else if supportsPhotoSearch && showPhotoPanel && pointClickMode {
                Divider()
                PhotoSearchSidePanel(
                    photos: searchedPhotos,
                    isLoading: isPhotoSearching,
                    isFetchingMore: isFetchingMorePhotos,
                    hasMore: hasMorePhotos,
                    statusText: pointClickStatus,
                    apiBaseURL: photoAPIBaseURL,
                    onClose: {
                        showPhotoPanel = false
                        rendererBox.renderer?.clearPhotoSearch()
                        searchedPhotos = []
                        isPhotoSearching = false
                        hasMorePhotos = false
                        isFetchingMorePhotos = false
                    },
                    onFetchMore: {
                        rendererBox.renderer?.fetchMorePhotos()
                        isFetchingMorePhotos = rendererBox.renderer?.isFetchingMorePhotos ?? true
                        hasMorePhotos = rendererBox.renderer?.hasMorePhotos ?? hasMorePhotos
                    }
                )
            }
        }
#if os(iOS) || os(visionOS)
        .sheet(isPresented: $isSharePresented) {
            if let shareScreenshotURL {
                ShareSheet(items: [shareScreenshotURL])
            }
        }
#endif
    }

    private func cancelScreenshotSelection() {
        guard isSelectingScreenshot else { return }
        isSelectingScreenshot = false
        toolHintOverride = nil
    }

    private func beginScreenshotSelection(purpose: ScreenshotSelectionPurpose) {
#if os(macOS)
        rendererBox.cameraView?.setMouseLookActive(false)
#endif
        if pointClickMode {
            rendererBox.renderer?.setPointClickMode(false)
            pointClickMode = false
            pointClickStatus = "Search Image off"
            showPhotoPanel = false
        }
        if measureMode {
            rendererBox.renderer?.setMeasureMode(false)
            measureMode = false
            measureDeleteMode = false
            measureStatus = rendererBox.renderer?.measureStatus ?? "Measure off"
        }
        screenshotSelectionPurpose = purpose
        toolHintOverride = nil
        isSelectingScreenshot = true
    }

    @MainActor
    private func captureAndSaveScreenshot(selection: CGRect, overlaySize: CGSize) async {
        isSavingScreenshot = true
        toolHintOverride = "Capturing screenshot…"

        guard let renderer = rendererBox.renderer,
              let fullImage = await renderer.captureScreenshotImage() else {
            isSavingScreenshot = false
            showToolHint("Screenshot failed. Try again.")
            return
        }

        let viewSize = screenshotViewSize(fallbackOverlay: overlaySize, renderer: renderer)
        guard viewSize.width > 1, viewSize.height > 1,
              let cropped = fullImage.cropped(to: selection, fromViewSize: viewSize),
              let pngData = cropped.pngDataCompatible() else {
            isSavingScreenshot = false
            showToolHint("Could not crop selection.")
            return
        }

        let formatter = DateFormatter()
        formatter.dateFormat = "yyyy-MM-dd_HH-mm-ss"
        let filename = "MetalSplatter_\(formatter.string(from: Date())).png"

#if os(macOS)
        let panel = NSSavePanel()
        panel.allowedContentTypes = [.png]
        panel.canCreateDirectories = true
        panel.isExtensionHidden = false
        panel.nameFieldStringValue = filename
        panel.title = "Save Screenshot"
        panel.message = "Choose where to save the screenshot"
        if let desktop = FileManager.default.urls(for: .desktopDirectory, in: .userDomainMask).first {
            panel.directoryURL = desktop
        }

        guard panel.runModal() == .OK, let url = panel.url else {
            isSavingScreenshot = false
            toolHintOverride = nil
            return
        }

        do {
            try pngData.write(to: url, options: .atomic)
            isSavingScreenshot = false
            showToolHint("Saved \(url.lastPathComponent)")
            NSWorkspace.shared.activateFileViewerSelecting([url])
        } catch {
            isSavingScreenshot = false
            showToolHint("Could not save: \(error.localizedDescription)")
        }
#else
        do {
            let url = FileManager.default.temporaryDirectory.appendingPathComponent(filename)
            try pngData.write(to: url, options: .atomic)
            shareScreenshotURL = url
            isSavingScreenshot = false
            toolHintOverride = nil
            isSharePresented = true
        } catch {
            isSavingScreenshot = false
            showToolHint("Could not save: \(error.localizedDescription)")
        }
#endif
    }

    private func showToolHint(_ message: String) {
        toolHintOverride = message
        Task { @MainActor in
            try? await Task.sleep(nanoseconds: 2_500_000_000)
            if toolHintOverride == message {
                toolHintOverride = nil
            }
        }
    }

    @MainActor
    private func captureAndSearchProducts(selection: CGRect, overlaySize: CGSize) async {
        productSearchTask?.cancel()

        guard let renderer = rendererBox.renderer else {
            productStatusText = "Renderer not ready"
            showProductPanel = true
            return
        }

        productMatches = []
        productPreview = nil
        isProductSearching = true
        productStatusText = "Capturing screenshot…"
        showProductPanel = true

        guard let fullImage = await renderer.captureScreenshotImage() else {
            isProductSearching = false
            productStatusText = "Screenshot failed. Try again."
            return
        }

        let viewSize = screenshotViewSize(fallbackOverlay: overlaySize, renderer: renderer)
        guard viewSize.width > 1, viewSize.height > 1,
              let cropped = fullImage.cropped(to: selection, fromViewSize: viewSize) else {
            isProductSearching = false
            productStatusText = "Could not crop selection."
            return
        }

        productPreview = cropped
        productStatusText = "Uploading screenshot and searching matches…"

        productSearchTask = Task {
            do {
                let matches = try await productSearchClient.searchProducts(image: cropped)
                guard !Task.isCancelled else { return }
                productMatches = matches
                isProductSearching = false
                productStatusText = "\(matches.count) visual matches"
            } catch {
                guard !Task.isCancelled else { return }
                productMatches = []
                isProductSearching = false
                productStatusText = error.localizedDescription
            }
        }
    }

    /// Points-space size matching the selection overlay (same as PlayCanvas canvas client rect).
    private func screenshotViewSize(fallbackOverlay: CGSize, renderer: MetalKitSceneRenderer) -> CGSize {
        if fallbackOverlay.width > 1, fallbackOverlay.height > 1 {
            return fallbackOverlay
        }
        if let bounds = rendererBox.viewBoundsSize, bounds.width > 1, bounds.height > 1 {
            return bounds
        }
        let drawable = renderer.drawableSize
#if os(macOS)
        let scale = renderer.metalKitView.window?.backingScaleFactor
            ?? NSScreen.main?.backingScaleFactor
            ?? 2
#else
        let scale = renderer.metalKitView.contentScaleFactor
#endif
        if scale > 0, drawable.width > 1, drawable.height > 1 {
            return CGSize(width: drawable.width / scale, height: drawable.height / scale)
        }
        return drawable
    }
}

@MainActor
final class ClientRendererBox {
    var renderer: MetalKitSceneRenderer?
#if os(macOS)
    weak var cameraView: ClientCameraControlMTKView?
#endif

    var viewBoundsSize: CGSize? {
#if os(macOS)
        cameraView?.bounds.size
#else
        renderer?.metalKitView.bounds.size
#endif
    }
}

#if os(iOS) || os(visionOS)
private struct ShareSheet: UIViewControllerRepresentable {
    let items: [Any]

    func makeUIViewController(context: Context) -> UIActivityViewController {
        UIActivityViewController(activityItems: items, applicationActivities: nil)
    }

    func updateUIViewController(_ uiViewController: UIActivityViewController, context: Context) {}
}
#endif

private struct MeasureSubButton: View {
    let title: String
    let systemImage: String
    let isActive: Bool
    let accent: Color
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            VStack(spacing: 2) {
                Image(systemName: systemImage)
                    .font(.system(size: 12, weight: .bold))
                Text(title)
                    .font(.system(size: 9, weight: .semibold))
            }
            .foregroundStyle(isActive ? accent : Color.white.opacity(0.9))
            .frame(width: 46, height: 40)
            .background {
                RoundedRectangle(cornerRadius: 8, style: .continuous)
                    .fill(Color(red: 0.08, green: 0.09, blue: 0.12))
            }
            .overlay {
                RoundedRectangle(cornerRadius: 8, style: .continuous)
                    .strokeBorder(isActive ? accent : Color.white.opacity(0.2), lineWidth: isActive ? 1.5 : 1)
            }
        }
        .buttonStyle(.plain)
        .help(title)
    }
}

private struct ViewerToolButton: View {
    let title: String
    let systemImage: String
    let isActive: Bool
    let accent: Color
    let isDisabled: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
#if os(iOS) || os(visionOS)
            Image(systemName: systemImage)
                .font(.system(size: 15, weight: .bold))
                .foregroundStyle(isActive ? accent : Color.white)
                .frame(width: 40, height: 40)
                .background {
                    RoundedRectangle(cornerRadius: 10, style: .continuous)
                        .fill(Color(red: 0.08, green: 0.09, blue: 0.12))
                }
                .overlay {
                    RoundedRectangle(cornerRadius: 10, style: .continuous)
                        .strokeBorder(isActive ? accent : Color.white.opacity(0.22), lineWidth: isActive ? 1.5 : 1)
                }
                .shadow(color: .black.opacity(0.55), radius: 6, y: 2)
#else
            HStack(spacing: 8) {
                Image(systemName: systemImage)
                    .font(.system(size: 14, weight: .bold))
                    .foregroundStyle(isActive ? accent : Color.white)
                    .frame(width: 16)

                Text(title)
                    .font(.system(size: 13, weight: .bold))
                    .foregroundStyle(Color.white)

                Spacer(minLength: 0)

                if isActive {
                    Circle()
                        .fill(accent)
                        .frame(width: 6, height: 6)
                }
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 12)
            .frame(width: 196, alignment: .leading)
            .background {
                RoundedRectangle(cornerRadius: 14, style: .continuous)
                    .fill(Color(red: 0.08, green: 0.09, blue: 0.12))
            }
            .overlay {
                RoundedRectangle(cornerRadius: 14, style: .continuous)
                    .strokeBorder(isActive ? accent : Color.white.opacity(0.22), lineWidth: isActive ? 1.5 : 1)
            }
            .shadow(color: .black.opacity(0.55), radius: 6, y: 2)
#endif
        }
        .buttonStyle(.plain)
        .disabled(isDisabled)
        .opacity(isDisabled ? 0.55 : 1)
        .accessibilityLabel(title)
        .help(title)
    }
}

private struct ClientSceneRepresentable: PlatformViewRepresentable {
    var modelIdentifier: ModelIdentifier?
    var photoAPIBaseURL: URL?
    var photoSearchUsesSPZCoordinates: Bool = false
    var photoSearchUsesServerCalibration: Bool = false
    var measureCalibrationFactor: Float = 1.0
    var rendererBox: ClientRendererBox
    var onPointClickStateChanged: () -> Void
    var onMeasureStateChanged: () -> Void
    var onModelLoadStateChanged: ((Bool) -> Void)?
    var onModelLoadFailed: ((String) -> Void)?

    final class Coordinator {
        var renderer: MetalKitSceneRenderer?
        var lastLoadedModel: ModelIdentifier?
    }

    func makeCoordinator() -> Coordinator { Coordinator() }

#if os(macOS)
    func makeNSView(context: Context) -> ClientCameraControlMTKView {
        makeView(context.coordinator)
    }

    func updateNSView(_ view: ClientCameraControlMTKView, context: Context) {
        updateView(view, context: context)
    }
#elseif os(iOS) || os(visionOS)
    func makeUIView(context: Context) -> ClientCameraControlMTKView {
        makeView(context.coordinator)
    }

    func updateUIView(_ view: ClientCameraControlMTKView, context: Context) {
        updateView(view, context: context)
    }
#endif

    private func makeView(_ coordinator: Coordinator) -> ClientCameraControlMTKView {
        let metalKitView = ClientCameraControlMTKView()
        if let metalDevice = MTLCreateSystemDefaultDevice() {
            metalKitView.device = metalDevice
        }

        let renderer = MetalKitSceneRenderer(metalKitView)
        renderer?.photoAPIBaseURL = photoAPIBaseURL
        renderer?.photoSearchUsesSPZCoordinates = photoSearchUsesSPZCoordinates
        renderer?.photoSearchUsesServerCalibration = photoSearchUsesServerCalibration
        renderer?.measureCalibrationFactor = measureCalibrationFactor
        coordinator.renderer = renderer
        metalKitView.delegate = renderer
        metalKitView.renderer = renderer
        rendererBox.renderer = renderer
#if os(macOS)
        rendererBox.cameraView = metalKitView
#endif
        renderer?.onPointClickStateChanged = onPointClickStateChanged
        renderer?.onMeasureStateChanged = onMeasureStateChanged

        loadModel(on: coordinator)
        return metalKitView
    }

    private func updateView(_ view: ClientCameraControlMTKView, context: Context) {
        if context.coordinator.lastLoadedModel != modelIdentifier {
            loadModel(on: context.coordinator)
        }
        view.renderer = context.coordinator.renderer
        rendererBox.renderer = context.coordinator.renderer
#if os(macOS)
        rendererBox.cameraView = view
#endif
        context.coordinator.renderer?.photoAPIBaseURL = photoAPIBaseURL
        context.coordinator.renderer?.photoSearchUsesSPZCoordinates = photoSearchUsesSPZCoordinates
        context.coordinator.renderer?.photoSearchUsesServerCalibration = photoSearchUsesServerCalibration
        context.coordinator.renderer?.measureCalibrationFactor = measureCalibrationFactor
        context.coordinator.renderer?.onPointClickStateChanged = onPointClickStateChanged
        context.coordinator.renderer?.onMeasureStateChanged = onMeasureStateChanged
    }

    private func loadModel(on coordinator: Coordinator) {
        guard let renderer = coordinator.renderer else { return }
        coordinator.lastLoadedModel = modelIdentifier
        onModelLoadStateChanged?(false)
        Task { @MainActor in
            do {
                try await renderer.load(modelIdentifier)
                onModelLoadStateChanged?(true)
            } catch {
                let message = friendlyLoadErrorMessage(for: error)
                print("Couldn't load model: \(message)")
                onModelLoadStateChanged?(false)
                onModelLoadFailed?(message)
            }
        }
    }
}

private func friendlyLoadErrorMessage(for error: Error) -> String {
    var current: Error? = error
    var depth = 0
    while let err = current, depth < 6 {
        let text = err.localizedDescription
        if text.localizedCaseInsensitiveContains("too large")
            || text.localizedCaseInsensitiveContains("decompressed") {
            return text
        }
        if text.localizedCaseInsensitiveContains("memory")
            || text.localizedCaseInsensitiveContains("allocation") {
            return "This scene is too large to open on this device. Try a smaller export."
        }
        let ns = err as NSError
        if let underlying = ns.userInfo[NSUnderlyingErrorKey] as? Error {
            current = underlying
            depth += 1
            continue
        }
        // Mirror SPZSceneReader.Error.readError(underlying)
        if let mirrorChild = Mirror(reflecting: err).children.first(where: { $0.label == nil || $0.label == "readError" }),
           let nested = mirrorChild.value as? Error {
            current = nested
            depth += 1
            continue
        }
        return text.isEmpty ? "Couldn't load this scene." : text
    }
    return "Couldn't load this scene."
}

#if os(macOS)
final class ClientCameraControlMTKView: MTKView {
    weak var renderer: MetalKitSceneRenderer?

    private enum KeyCode {
        static let a: UInt16 = 0
        static let s: UInt16 = 1
        static let d: UInt16 = 2
        static let w: UInt16 = 13
        static let escape: UInt16 = 53
        static let leftArrow: UInt16 = 123
        static let rightArrow: UInt16 = 124
        static let downArrow: UInt16 = 125
        static let upArrow: UInt16 = 126
    }

    private var pressedKeys = Set<UInt16>()
    private var isMouseLookActive = false
    private var resignObserver: NSObjectProtocol?
    /// Distinguishes a click (place measure / search point) from a drag-to-look.
    private var toolMouseDownLocation: CGPoint?
    private var didDragLookFromToolClick = false
    private let toolDragLookThreshold: CGFloat = 4

    override var acceptsFirstResponder: Bool { true }

    private var isToolClickMode: Bool {
        renderer?.measureMode == true || renderer?.pointClickMode == true
    }

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()

        if let resignObserver {
            NotificationCenter.default.removeObserver(resignObserver)
            self.resignObserver = nil
        }

        guard let window else {
            setMouseLookActive(false)
            return
        }

        window.acceptsMouseMovedEvents = true
        window.makeFirstResponder(self)

        resignObserver = NotificationCenter.default.addObserver(
            forName: NSWindow.didResignKeyNotification,
            object: window,
            queue: .main
        ) { [weak self] _ in
            Task { @MainActor in
                self?.setMouseLookActive(false)
            }
        }
    }

    override func mouseDown(with event: NSEvent) {
        window?.makeFirstResponder(self)
        let locationInView = convert(event.locationInWindow, from: nil)

        if isToolClickMode {
            // Defer the tool action until mouseUp so a drag can look instead.
            setMouseLookActive(false)
            toolMouseDownLocation = locationInView
            didDragLookFromToolClick = false
            return
        }

        toolMouseDownLocation = nil
        didDragLookFromToolClick = false
        setMouseLookActive(true)
    }

    override func mouseDragged(with event: NSEvent) {
        guard isToolClickMode, toolMouseDownLocation != nil else {
            super.mouseDragged(with: event)
            return
        }

        if !didDragLookFromToolClick {
            let locationInView = convert(event.locationInWindow, from: nil)
            let start = toolMouseDownLocation ?? locationInView
            if hypot(locationInView.x - start.x, locationInView.y - start.y) > toolDragLookThreshold {
                didDragLookFromToolClick = true
            }
        }

        if didDragLookFromToolClick {
            // Invert drag-look: cursor right/down pushes the view the opposite way (grab-style).
            renderer?.applyLookDelta(deltaX: -event.deltaX, deltaY: -event.deltaY)
        }
    }

    override func mouseUp(with event: NSEvent) {
        defer {
            toolMouseDownLocation = nil
            didDragLookFromToolClick = false
        }

        guard isToolClickMode,
              toolMouseDownLocation != nil,
              !didDragLookFromToolClick else {
            return
        }

        let locationInView = convert(event.locationInWindow, from: nil)
        if renderer?.measureMode == true {
            renderer?.handleMeasureClick(at: locationInView)
        } else if renderer?.pointClickMode == true {
            renderer?.handlePointClick(at: locationInView)
        }
    }

    override func rightMouseDown(with event: NSEvent) {
        window?.makeFirstResponder(self)
        // PlayCanvas exits pointer-lock while measuring so the cone tracks the real cursor.
        if renderer?.measureMode == true {
            setMouseLookActive(false)
            return
        }
        if renderer?.pointClickMode == true {
            setMouseLookActive(!isMouseLookActive)
            return
        }
        setMouseLookActive(true)
    }

    override func mouseMoved(with event: NSEvent) {
        if renderer?.measureMode == true {
            if isMouseLookActive { setMouseLookActive(false) }
            // Skip hover updates while drag-looking so the reticle doesn't fight the camera.
            if toolMouseDownLocation != nil { return }
            let locationInView = convert(event.locationInWindow, from: nil)
            renderer?.updateMeasureHover(at: locationInView)
            return
        }
        guard isMouseLookActive, renderer?.pointClickMode != true else { return }
        renderer?.applyLookDelta(deltaX: event.deltaX, deltaY: event.deltaY)
    }

    override func keyDown(with event: NSEvent) {
        if event.keyCode == KeyCode.escape {
            setMouseLookActive(false)
            return
        }
        // Cmd/Ctrl+Z undo while measuring
        if renderer?.measureMode == true,
           event.charactersIgnoringModifiers == "z",
           event.modifierFlags.contains(.command) || event.modifierFlags.contains(.control) {
            _ = renderer?.undoMeasurePoint()
            return
        }
        pressedKeys.insert(event.keyCode)
        applyMovementFromKeys()
    }

    override func keyUp(with event: NSEvent) {
        pressedKeys.remove(event.keyCode)
        applyMovementFromKeys()
    }

    func setMouseLookActive(_ active: Bool) {
        guard isMouseLookActive != active else { return }
        isMouseLookActive = active
        if active {
            CGAssociateMouseAndMouseCursorPosition(0)
            NSCursor.hide()
        } else {
            CGAssociateMouseAndMouseCursorPosition(1)
            NSCursor.unhide()
        }
    }

    private func applyMovementFromKeys() {
        guard let renderer else { return }
        renderer.movement = .init(
            forward: pressedKeys.contains(KeyCode.w) || pressedKeys.contains(KeyCode.upArrow),
            backward: pressedKeys.contains(KeyCode.s) || pressedKeys.contains(KeyCode.downArrow),
            left: pressedKeys.contains(KeyCode.a) || pressedKeys.contains(KeyCode.leftArrow),
            right: pressedKeys.contains(KeyCode.d) || pressedKeys.contains(KeyCode.rightArrow),
            up: false,
            down: false
        )
    }
}
#elseif os(iOS) || os(visionOS)
final class ClientCameraControlMTKView: MTKView {
    weak var renderer: MetalKitSceneRenderer?
    private var touchStartLocation: CGPoint?
    private var didDragLook = false
    private let tapMovementThreshold: CGFloat = 8
    private var movementPadInstalled = false

    private enum MoveFlag: Int {
        case forward = 1
        case backward = 2
        case left = 3
        case right = 4
    }

    override init(frame frameRect: CGRect, device: MTLDevice?) {
        super.init(frame: frameRect, device: device)
        isMultipleTouchEnabled = true
        installMovementPadIfNeeded()
    }

    required init(coder: NSCoder) {
        super.init(coder: coder)
        isMultipleTouchEnabled = true
        installMovementPadIfNeeded()
    }

    private func installMovementPadIfNeeded() {
        guard !movementPadInstalled else { return }
        movementPadInstalled = true

        let pad = UIStackView()
        pad.axis = .vertical
        pad.alignment = .center
        pad.spacing = 5
        pad.isLayoutMarginsRelativeArrangement = true
        pad.layoutMargins = UIEdgeInsets(top: 8, left: 8, bottom: 8, right: 8)
        pad.backgroundColor = UIColor.black.withAlphaComponent(0.4)
        pad.layer.cornerRadius = 12
        pad.clipsToBounds = true
        pad.translatesAutoresizingMaskIntoConstraints = false

        let forward = makeMoveButton(systemName: "arrow.up", flag: .forward)
        let left = makeMoveButton(systemName: "arrow.left", flag: .left)
        let backward = makeMoveButton(systemName: "arrow.down", flag: .backward)
        let right = makeMoveButton(systemName: "arrow.right", flag: .right)

        let row = UIStackView(arrangedSubviews: [left, backward, right])
        row.axis = .horizontal
        row.spacing = 5

        pad.addArrangedSubview(forward)
        pad.addArrangedSubview(row)
        addSubview(pad)

        NSLayoutConstraint.activate([
            pad.trailingAnchor.constraint(equalTo: safeAreaLayoutGuide.trailingAnchor, constant: -12),
            pad.bottomAnchor.constraint(equalTo: safeAreaLayoutGuide.bottomAnchor, constant: -12),
        ])
    }

    private func makeMoveButton(systemName: String, flag: MoveFlag) -> UIButton {
        var config = UIButton.Configuration.plain()
        config.image = UIImage(systemName: systemName)?
            .withConfiguration(UIImage.SymbolConfiguration(pointSize: 14, weight: .semibold))
        config.baseForegroundColor = .white
        config.background.backgroundColor = UIColor.white.withAlphaComponent(0.18)
        config.background.cornerRadius = 9
        config.contentInsets = NSDirectionalEdgeInsets(top: 9, leading: 9, bottom: 9, trailing: 9)

        let button = UIButton(configuration: config)
        button.tag = flag.rawValue
        button.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            button.widthAnchor.constraint(equalToConstant: 40),
            button.heightAnchor.constraint(equalToConstant: 40),
        ])

        button.addTarget(self, action: #selector(movePressed(_:)), for: .touchDown)
        button.addTarget(self, action: #selector(moveReleased(_:)), for: [.touchUpInside, .touchUpOutside, .touchCancel])
        return button
    }

    @objc private func movePressed(_ sender: UIButton) {
        setMoveFlag(tag: sender.tag, active: true)
    }

    @objc private func moveReleased(_ sender: UIButton) {
        setMoveFlag(tag: sender.tag, active: false)
    }

    private func setMoveFlag(tag: Int, active: Bool) {
        guard let renderer, let flag = MoveFlag(rawValue: tag) else { return }
        var movement = renderer.movement
        switch flag {
        case .forward: movement.forward = active
        case .backward: movement.backward = active
        case .left: movement.left = active
        case .right: movement.right = active
        }
        renderer.movement = movement
    }

    override func touchesBegan(_ touches: Set<UITouch>, with event: UIEvent?) {
        // Ignore look gestures that start on the movement pad.
        if let touch = touches.first, touch.view is UIControl || touch.view?.superview is UIStackView {
            return
        }
        touchStartLocation = touches.first?.location(in: self)
        didDragLook = false
    }

    override func touchesMoved(_ touches: Set<UITouch>, with event: UIEvent?) {
        guard let touch = touches.first, let start = touchStartLocation else { return }
        let location = touch.location(in: self)
        if hypot(location.x - start.x, location.y - start.y) > tapMovementThreshold {
            didDragLook = true
        }

        let inToolClickMode = renderer?.measureMode == true || renderer?.pointClickMode == true
        // In measure / image search, only look after the drag threshold so a tap still places a point.
        guard didDragLook || !inToolClickMode else { return }

        let previous = touch.previousLocation(in: self)
        renderer?.applyLookDelta(
            deltaX: location.x - previous.x,
            deltaY: location.y - previous.y
        )
    }

    override func touchesEnded(_ touches: Set<UITouch>, with event: UIEvent?) {
        defer {
            touchStartLocation = nil
            didDragLook = false
        }

        guard touchStartLocation != nil,
              !didDragLook,
              let location = touches.first?.location(in: self) else {
            return
        }
        if renderer?.measureMode == true {
            renderer?.handleMeasureClick(at: location)
            return
        }
        guard renderer?.pointClickMode == true else { return }
        renderer?.handlePointClick(at: location)
    }

    override func touchesCancelled(_ touches: Set<UITouch>, with event: UIEvent?) {
        touchStartLocation = nil
        didDragLook = false
    }
}
#endif
