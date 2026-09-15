import SwiftUI
import MetalKit
import AppKit
import CoreGraphics

/// Client splat viewer for MacApp: Point Click only.
struct ClientSceneView: View {
    var modelIdentifier: ModelIdentifier?
    var onModelLoadStateChanged: ((Bool) -> Void)? = nil

    @State private var rendererBox = ClientRendererBox()
    @State private var pointClickMode = false
    @State private var pointClickStatus = "Point Click off"
    @State private var searchedPhotos: [PhotoSearchResult] = []
    @State private var isPhotoSearching = false
    @State private var showPhotoPanel = false

    var body: some View {
        HStack(spacing: 0) {
            ZStack(alignment: .bottom) {
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

                VStack(spacing: 12) {
                    HStack(alignment: .top) {
                        Button(pointClickMode ? "Point Click: On" : "Point Click") {
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
                        .buttonStyle(.borderedProminent)
                        .tint(pointClickMode ? .orange : .accentColor)

                        if pointClickMode || pointClickStatus != "Point Click off" {
                            Text(pointClickStatus)
                                .font(.system(.body, design: .monospaced))
                                .foregroundStyle(.white)
                                .padding(.horizontal, 10)
                                .padding(.vertical, 8)
                                .background(.black.opacity(0.55), in: RoundedRectangle(cornerRadius: 8))
                        }

                        Spacer()
                    }
                    .padding(.horizontal)

                    Text(pointClickMode
                         ? "Point Click on · click a surface to search photos · Esc exits look"
                         : "Click to look · mouse looks around · WASD/arrows move · Esc releases cursor")
                        .font(.caption)
                        .foregroundStyle(.white.opacity(0.85))
                        .padding(8)
                        .background(.black.opacity(0.45), in: RoundedRectangle(cornerRadius: 8))
                }
                .padding()
            }

            if showPhotoPanel && pointClickMode {
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
}

@MainActor
final class ClientRendererBox {
    var renderer: MetalKitSceneRenderer?
    weak var cameraView: ClientCameraControlMTKView?
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
