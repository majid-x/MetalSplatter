#if os(iOS) || os(macOS)

import SwiftUI
import MetalKit

#if os(macOS)
import AppKit
import CoreGraphics
private typealias PlatformViewRepresentable = NSViewRepresentable
#elseif os(iOS)
import UIKit
private typealias PlatformViewRepresentable = UIViewRepresentable
#endif

struct MetalKitSceneView: View {
    var modelIdentifier: ModelIdentifier?
    @State private var rendererBox = RendererBox()
    @State private var pointClickMode = false
    @State private var pointClickStatus = "Point Click off"
    @State private var searchedPhotos: [PhotoSearchResult] = []
    @State private var isPhotoSearching = false
    @State private var showPhotoPanel = false

    var body: some View {
        HStack(spacing: 0) {
            ZStack(alignment: .bottom) {
                MetalKitSceneRepresentable(
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
                    }
                )
                .frame(maxWidth: .infinity, maxHeight: .infinity)

                VStack(spacing: 12) {
                    HStack(alignment: .top) {
                        Button(pointClickMode ? "Point Click: On" : "Point Click") {
                            let enabled = !pointClickMode
#if os(macOS)
                            rendererBox.cameraView?.setMouseLookActive(false)
#endif
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

                        // Debug: live camera pose for setting a PLY spawn later.
                        TimelineView(.periodic(from: .now, by: 0.1)) { _ in
                            Text(cameraDebugText)
                                .font(.system(.caption, design: .monospaced))
                                .foregroundStyle(.white)
                                .multilineTextAlignment(.trailing)
                                .padding(.horizontal, 10)
                                .padding(.vertical, 8)
                                .background(.black.opacity(0.55), in: RoundedRectangle(cornerRadius: 8))
                        }
                    }
                    .padding(.horizontal)

#if os(macOS)
                    Text(pointClickMode
                          ? "Point Click on · click a surface to search photos · Esc exits look · toggle button to leave mode"
                          : "Click to look · mouse looks around · WASD/arrows move · Esc releases cursor")
                        .font(.caption)
                        .padding(8)
                        .background(.black.opacity(0.45), in: RoundedRectangle(cornerRadius: 8))
#elseif os(iOS)
                    MovementPad(rendererBox: rendererBox)
#endif
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

    private var cameraDebugText: String {
        guard let renderer = rendererBox.renderer else {
            return "cam: (no renderer)"
        }
        let p = renderer.cameraPosition
        let yawDeg = renderer.cameraYaw * 180 / .pi
        let pitchDeg = renderer.cameraPitch * 180 / .pi
        return String(
            format: "cam xyz: %.3f, %.3f, %.3f\nyaw: %.1f°  pitch: %.1f°",
            p.x, p.y, p.z, yawDeg, pitchDeg
        )
    }
}

@MainActor
final class RendererBox {
    var renderer: MetalKitSceneRenderer?
#if os(macOS)
    weak var cameraView: CameraControlMTKView?
#endif
}

#if os(iOS)
private struct MovementPad: View {
    let rendererBox: RendererBox

    var body: some View {
        VStack(spacing: 8) {
            holdButton(systemName: "arrow.up", set: { $0.forward = $1 })
            HStack(spacing: 8) {
                holdButton(systemName: "arrow.left", set: { $0.left = $1 })
                holdButton(systemName: "arrow.down", set: { $0.backward = $1 })
                holdButton(systemName: "arrow.right", set: { $0.right = $1 })
            }
        }
        .padding(12)
        .background(.black.opacity(0.35), in: RoundedRectangle(cornerRadius: 16))
    }

    private func holdButton(systemName: String,
                            set: @escaping (inout MetalKitSceneRenderer.MovementInput, Bool) -> Void) -> some View {
        Image(systemName: systemName)
            .font(.title2.weight(.semibold))
            .foregroundStyle(.white)
            .frame(width: 56, height: 56)
            .background(.white.opacity(0.18), in: RoundedRectangle(cornerRadius: 12))
            .gesture(
                DragGesture(minimumDistance: 0)
                    .onChanged { _ in updateMovement(set: set, active: true) }
                    .onEnded { _ in updateMovement(set: set, active: false) }
            )
    }

    private func updateMovement(set: (inout MetalKitSceneRenderer.MovementInput, Bool) -> Void, active: Bool) {
        guard let renderer = rendererBox.renderer else { return }
        var movement = renderer.movement
        set(&movement, active)
        renderer.movement = movement
    }
}
#endif

private struct MetalKitSceneRepresentable: PlatformViewRepresentable {
    var modelIdentifier: ModelIdentifier?
    var rendererBox: RendererBox
    var onPointClickStateChanged: () -> Void

    final class Coordinator {
        var renderer: MetalKitSceneRenderer?
    }

    func makeCoordinator() -> Coordinator {
        Coordinator()
    }

#if os(macOS)
    func makeNSView(context: Context) -> CameraControlMTKView {
        makeView(context.coordinator)
    }

    func updateNSView(_ view: CameraControlMTKView, context: Context) {
        updateView(context.coordinator)
        view.renderer = context.coordinator.renderer
        rendererBox.renderer = context.coordinator.renderer
        rendererBox.cameraView = view
        context.coordinator.renderer?.onPointClickStateChanged = onPointClickStateChanged
    }
#elseif os(iOS)
    func makeUIView(context: Context) -> CameraControlMTKView {
        makeView(context.coordinator)
    }

    func updateUIView(_ view: CameraControlMTKView, context: Context) {
        updateView(context.coordinator)
        view.renderer = context.coordinator.renderer
        rendererBox.renderer = context.coordinator.renderer
        context.coordinator.renderer?.onPointClickStateChanged = onPointClickStateChanged
    }
#endif

    private func makeView(_ coordinator: Coordinator) -> CameraControlMTKView {
        let metalKitView = CameraControlMTKView()
        if let metalDevice = MTLCreateSystemDefaultDevice() {
            metalKitView.device = metalDevice
        }

        let renderer = MetalKitSceneRenderer(metalKitView)
        coordinator.renderer = renderer
        metalKitView.delegate = renderer
        metalKitView.renderer = renderer
        rendererBox.renderer = renderer
#if os(macOS)
        rendererBox.cameraView = metalKitView
#endif
        renderer?.onPointClickStateChanged = onPointClickStateChanged

        Task {
            do {
                try await renderer?.load(modelIdentifier)
            } catch {
                print("Error loading model: \(error.localizedDescription)")
            }
        }

        return metalKitView
    }

    private func updateView(_ coordinator: Coordinator) {
        guard let renderer = coordinator.renderer else { return }
        Task {
            do {
                try await renderer.load(modelIdentifier)
            } catch {
                print("Error loading model: \(error.localizedDescription)")
            }
        }
    }
}

#if os(macOS)
/// FPS-style controls: hidden cursor mouse-look + WASD / arrows.
final class CameraControlMTKView: MTKView {
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
            right: pressedKeys.contains(KeyCode.d) || pressedKeys.contains(KeyCode.rightArrow)
        )
    }
}
#elseif os(iOS)
/// Touch look (drag) + tap-to-pick in Point Click mode.
final class CameraControlMTKView: MTKView {
    weak var renderer: MetalKitSceneRenderer?
    private var touchStartLocation: CGPoint?
    private var didDragLook = false
    private let tapMovementThreshold: CGFloat = 8

    override init(frame frameRect: CGRect, device: MTLDevice?) {
        super.init(frame: frameRect, device: device)
        isMultipleTouchEnabled = true
    }

    required init(coder: NSCoder) {
        super.init(coder: coder)
        isMultipleTouchEnabled = true
    }

    override func touchesBegan(_ touches: Set<UITouch>, with event: UIEvent?) {
        touchStartLocation = touches.first?.location(in: self)
        didDragLook = false
    }

    override func touchesMoved(_ touches: Set<UITouch>, with event: UIEvent?) {
        guard renderer?.pointClickMode != true else { return }
        guard let touch = touches.first, let start = touchStartLocation else { return }
        let location = touch.location(in: self)
        let delta = CGPoint(x: location.x - start.x, y: location.y - start.y)
        if hypot(delta.x, delta.y) > tapMovementThreshold {
            didDragLook = true
        }
        let previous = touch.previousLocation(in: self)
        renderer?.applyLookDelta(
            deltaX: location.x - previous.x,
            deltaY: location.y - previous.y
        )
        touchStartLocation = location
    }

    override func touchesEnded(_ touches: Set<UITouch>, with event: UIEvent?) {
        defer {
            touchStartLocation = nil
            didDragLook = false
        }

        guard renderer?.pointClickMode == true,
              !didDragLook,
              let location = touches.first?.location(in: self) else {
            return
        }
        renderer?.handlePointClick(at: location)
    }

    override func touchesCancelled(_ touches: Set<UITouch>, with event: UIEvent?) {
        touchStartLocation = nil
        didDragLook = false
    }
}
#endif

#endif // os(iOS) || os(macOS)
