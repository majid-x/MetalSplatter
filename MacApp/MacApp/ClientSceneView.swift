import SwiftUI
import MetalKit
import AppKit
import CoreGraphics
import UniformTypeIdentifiers

/// Client splat viewer for MacApp: Point Click + Search Products.
struct ClientSceneView: View {
    var modelIdentifier: ModelIdentifier?
    var onModelLoadStateChanged: ((Bool) -> Void)? = nil

    @State private var rendererBox = ClientRendererBox()
    @State private var pointClickMode = false
    @State private var pointClickStatus = "Point Click off"
    @State private var searchedPhotos: [PhotoSearchResult] = []
    @State private var isPhotoSearching = false
    @State private var showPhotoPanel = false

    @State private var isSelectingScreenshot = false
    /// What to do after a drag-selection completes.
    @State private var screenshotSelectionPurpose: ScreenshotSelectionPurpose = .productSearch
    @State private var showProductPanel = false
    @State private var productMatches: [ProductSearchMatch] = []
    @State private var productPreview: NSImage?
    @State private var isProductSearching = false
    @State private var productStatusText = "Take a screenshot to search visual matches."
    @State private var productSearchTask: Task<Void, Never>?
    @State private var productSearchClient = ProductSearchClient()
    @State private var isSavingScreenshot = false
    @State private var toolHintOverride: String?

    private enum ScreenshotSelectionPurpose {
        case productSearch
        case saveToDisk
    }

    var body: some View {
        HStack(spacing: 0) {
            ZStack(alignment: .bottomLeading) {
                ClientSceneRepresentable(
                    modelIdentifier: modelIdentifier,
                    rendererBox: rendererBox,
                    onPointClickStateChanged: {
                        pointClickMode = rendererBox.renderer?.pointClickMode ?? false
                        pointClickStatus = rendererBox.renderer?.pointClickStatus ?? "Point Click off"
                        searchedPhotos = rendererBox.renderer?.searchedPhotos ?? []
                        isPhotoSearching = rendererBox.renderer?.isPhotoSearching ?? false
                        if isPhotoSearching || !searchedPhotos.isEmpty {
                            showPhotoPanel = true
                        }
                    },
                    onModelLoadStateChanged: onModelLoadStateChanged
                )
                .frame(maxWidth: .infinity, maxHeight: .infinity)

                VStack(alignment: .leading, spacing: 10) {
                    VStack(alignment: .leading, spacing: 8) {
                        ViewerToolButton(
                            title: pointClickMode ? "Point Click On" : "Point Click",
                            systemImage: "hand.tap",
                            isActive: pointClickMode,
                            accent: Color(red: 1.0, green: 0.55, blue: 0.22),
                            isDisabled: isSelectingScreenshot || isSavingScreenshot
                        ) {
                            let enabled = !pointClickMode
                            rendererBox.cameraView?.setMouseLookActive(false)
                            rendererBox.renderer?.setPointClickMode(enabled)
                            pointClickMode = enabled
                            pointClickStatus = rendererBox.renderer?.pointClickStatus ?? pointClickStatus
                            if !enabled {
                                showPhotoPanel = false
                                searchedPhotos = []
                                isPhotoSearching = false
                            }
                        }

                        ViewerToolButton(
                            title: "Search Products",
                            systemImage: "bag",
                            isActive: (isSelectingScreenshot && screenshotSelectionPurpose == .productSearch)
                                || isProductSearching
                                || showProductPanel,
                            accent: Color(red: 0.22, green: 0.52, blue: 1.0),
                            isDisabled: isSelectingScreenshot || isProductSearching || isSavingScreenshot
                        ) {
                            beginScreenshotSelection(purpose: .productSearch)
                        }

                        ViewerToolButton(
                            title: isSavingScreenshot ? "Saving…" : "Screenshot",
                            systemImage: "camera",
                            isActive: (isSelectingScreenshot && screenshotSelectionPurpose == .saveToDisk)
                                || isSavingScreenshot,
                            accent: Color(red: 0.25, green: 0.78, blue: 0.55),
                            isDisabled: isSelectingScreenshot || isSavingScreenshot
                        ) {
                            beginScreenshotSelection(purpose: .saveToDisk)
                        }
                    }

                    if pointClickMode || pointClickStatus != "Point Click off" {
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

                    Text(toolHintOverride
                         ?? (isSelectingScreenshot
                         ? "Drag to select an area · Esc cancels"
                         : pointClickMode
                         ? "Point Click on · click a surface to search photos · Esc exits look"
                         : "Click to look · mouse looks around · WASD/arrows move · Esc releases cursor"))
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
                        onComplete: { rect in
                            let purpose = screenshotSelectionPurpose
                            isSelectingScreenshot = false
                            switch purpose {
                            case .productSearch:
                                Task { await captureAndSearchProducts(selection: rect) }
                            case .saveToDisk:
                                Task { await captureAndSaveScreenshot(selection: rect) }
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
            } else if showPhotoPanel && pointClickMode {
                Divider()
                PhotoSearchSidePanel(
                    photos: searchedPhotos,
                    isLoading: isPhotoSearching,
                    statusText: pointClickStatus,
                    onClose: {
                        showPhotoPanel = false
                        rendererBox.renderer?.clearPhotoSearch()
                        searchedPhotos = []
                        isPhotoSearching = false
                    }
                )
            }
        }
    }

    private func beginScreenshotSelection(purpose: ScreenshotSelectionPurpose) {
        rendererBox.cameraView?.setMouseLookActive(false)
        if pointClickMode {
            rendererBox.renderer?.setPointClickMode(false)
            pointClickMode = false
            pointClickStatus = "Point Click off"
            showPhotoPanel = false
        }
        screenshotSelectionPurpose = purpose
        toolHintOverride = nil
        isSelectingScreenshot = true
    }

    @MainActor
    private func captureAndSaveScreenshot(selection: CGRect) async {
        isSavingScreenshot = true
        toolHintOverride = "Capturing screenshot…"

        guard let renderer = rendererBox.renderer,
              let fullImage = await renderer.captureScreenshotImage() else {
            isSavingScreenshot = false
            showToolHint("Screenshot failed. Try again.")
            return
        }

        let viewSize = rendererBox.cameraView?.bounds.size
            ?? renderer.drawableSize
        guard viewSize.width > 1, viewSize.height > 1,
              let cropped = fullImage.cropped(to: selection, fromViewSize: viewSize),
              let pngData = cropped.pngData() else {
            isSavingScreenshot = false
            showToolHint("Could not crop selection.")
            return
        }

        let formatter = DateFormatter()
        formatter.dateFormat = "yyyy-MM-dd_HH-mm-ss"
        let filename = "MetalSplatter_\(formatter.string(from: Date())).png"

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
    private func captureAndSearchProducts(selection: CGRect) async {
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

        let viewSize = rendererBox.cameraView?.bounds.size
            ?? renderer.drawableSize
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
}

@MainActor
final class ClientRendererBox {
    var renderer: MetalKitSceneRenderer?
    weak var cameraView: ClientCameraControlMTKView?
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
            HStack(spacing: 10) {
                Image(systemName: systemImage)
                    .font(.system(size: 14, weight: .bold))
                    .foregroundStyle(isActive ? accent : Color.white)
                    .frame(width: 20)

                Text(title)
                    .font(.system(size: 13, weight: .bold))
                    .foregroundStyle(Color.white)

                Spacer(minLength: 0)

                if isActive {
                    Circle()
                        .fill(accent)
                        .frame(width: 8, height: 8)
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
            .shadow(color: .black.opacity(0.55), radius: 8, y: 3)
        }
        .buttonStyle(.plain)
        .disabled(isDisabled)
        .opacity(isDisabled ? 0.55 : 1)
    }
}

private struct ClientSceneRepresentable: NSViewRepresentable {
    var modelIdentifier: ModelIdentifier?
    var rendererBox: ClientRendererBox
    var onPointClickStateChanged: () -> Void
    var onModelLoadStateChanged: ((Bool) -> Void)?

    final class Coordinator {
        var renderer: MetalKitSceneRenderer?
        var lastLoadedModel: ModelIdentifier?
    }

    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeNSView(context: Context) -> ClientCameraControlMTKView {
        let metalKitView = ClientCameraControlMTKView()
        if let metalDevice = MTLCreateSystemDefaultDevice() {
            metalKitView.device = metalDevice
        }

        let renderer = MetalKitSceneRenderer(metalKitView)
        context.coordinator.renderer = renderer
        metalKitView.delegate = renderer
        metalKitView.renderer = renderer
        rendererBox.renderer = renderer
        rendererBox.cameraView = metalKitView
        renderer?.onPointClickStateChanged = onPointClickStateChanged

        loadModel(on: context.coordinator)
        return metalKitView
    }

    func updateNSView(_ view: ClientCameraControlMTKView, context: Context) {
        if context.coordinator.lastLoadedModel != modelIdentifier {
            loadModel(on: context.coordinator)
        }
        view.renderer = context.coordinator.renderer
        rendererBox.renderer = context.coordinator.renderer
        rendererBox.cameraView = view
        context.coordinator.renderer?.onPointClickStateChanged = onPointClickStateChanged
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
                print("Error loading model: \(error.localizedDescription)")
                onModelLoadStateChanged?(false)
            }
        }
    }
}

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

    override var acceptsFirstResponder: Bool { true }

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

        if renderer?.pointClickMode == true {
            setMouseLookActive(false)
            renderer?.handlePointClick(at: locationInView)
            return
        }

        setMouseLookActive(true)
    }

    override func rightMouseDown(with event: NSEvent) {
        window?.makeFirstResponder(self)
        if renderer?.pointClickMode == true {
            setMouseLookActive(!isMouseLookActive)
            return
        }
        setMouseLookActive(true)
    }

    override func mouseMoved(with event: NSEvent) {
        guard isMouseLookActive, renderer?.pointClickMode != true else { return }
        renderer?.applyLookDelta(deltaX: event.deltaX, deltaY: event.deltaY)
    }

    override func keyDown(with event: NSEvent) {
        if event.keyCode == KeyCode.escape {
            setMouseLookActive(false)
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
