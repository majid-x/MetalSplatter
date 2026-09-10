#if os(iOS) || os(macOS)

import Metal
import MetalKit
import MetalSplatter
import os
import SampleBoxRenderer
import simd
import SplatIO
import SwiftUI

@MainActor
class MetalKitSceneRenderer: NSObject, MTKViewDelegate {
    struct MovementInput: Equatable {
        var forward = false
        var backward = false
        var left = false
        var right = false

        var isActive: Bool { forward || backward || left || right }
    }

    private static let log =
        Logger(subsystem: Bundle.main.bundleIdentifier!,
               category: "MetalKitSceneRenderer")

    let metalKitView: MTKView
    let device: MTLDevice
    let commandQueue: MTLCommandQueue

    var model: ModelIdentifier?
    var modelRenderer: (any ModelRenderer)?
    var proceduralSplatController: ProceduralSplatController?

    let inFlightSemaphore = DispatchSemaphore(value: Constants.maxSimultaneousRenders)

    /// Camera position in world space. Default looks toward the origin down -Z.
    var cameraPosition = SIMD3<Float>(0, 0, Constants.cameraStartZ)
    /// Yaw around +Y (0 = looking down -Z). Pitch around local +X.
    var cameraYaw: Float = 0
    var cameraPitch: Float = 0
    var movement = MovementInput()

    /// When true, clicks pick a surface point instead of capturing the mouse for look.
    var pointClickMode = false
    /// Latest successfully picked world-space coordinate, if any.
    var lastPickedCoordinate: SIMD3<Float>?
    /// Status line shown next to the Point Click UI.
    var pointClickStatus: String = "Point Click off"

    private var lastCameraUpdateTimestamp: Date? = nil
    private var lastProjectionMatrix = matrix_identity_float4x4
    private var lastViewMatrix = matrix_identity_float4x4
    private var depthReadbackBuffer: MTLBuffer?
    var drawableSize: CGSize = .zero

    /// Notifies SwiftUI overlays when pick / mode state changes.
    var onPointClickStateChanged: (() -> Void)?

    init?(_ metalKitView: MTKView) {
        self.device = metalKitView.device!
        guard let queue = self.device.makeCommandQueue() else { return nil }
        self.commandQueue = queue
        self.metalKitView = metalKitView
        metalKitView.colorPixelFormat = MTLPixelFormat.bgra8Unorm_srgb
        metalKitView.depthStencilPixelFormat = MTLPixelFormat.depth32Float
        metalKitView.sampleCount = 1
        metalKitView.clearColor = MTLClearColor(red: 0, green: 0, blue: 0, alpha: 0)
        depthReadbackBuffer = device.makeBuffer(length: MemoryLayout<Float>.size, options: .storageModeShared)
    }

    func load(_ model: ModelIdentifier?) async throws {
        guard model != self.model else { return }
        self.model = model

        modelRenderer = nil
        proceduralSplatController = nil
        cameraPosition = SIMD3<Float>(0, 0, Constants.cameraStartZ)
        cameraYaw = 0
        cameraPitch = 0
        lastCameraUpdateTimestamp = nil
        lastPickedCoordinate = nil
        if pointClickMode {
            pointClickStatus = "Click a surface to read XYZ"
        } else {
            pointClickStatus = "Point Click off"
        }
        onPointClickStateChanged?()

        switch model {
        case .gaussianSplat(let url):
            let splat = try SplatRenderer(device: device,
                                          colorFormat: metalKitView.colorPixelFormat,
                                          depthFormat: metalKitView.depthStencilPixelFormat,
                                          sampleCount: metalKitView.sampleCount,
                                          maxViewCount: 1,
                                          maxSimultaneousRenders: Constants.maxSimultaneousRenders)
            let reader = try AutodetectSceneReader(url)
            let points = try await reader.readAll()
            let chunk = try SplatChunk(device: device, from: points)
            await splat.addChunk(chunk)
            modelRenderer = splat
        case .proceduralSplat:
            let controller = try await ProceduralSplatController(
                device: device,
                colorFormat: metalKitView.colorPixelFormat,
                depthFormat: metalKitView.depthStencilPixelFormat,
                sampleCount: metalKitView.sampleCount,
                maxViewCount: 1,
                maxSimultaneousRenders: Constants.maxSimultaneousRenders)
            proceduralSplatController = controller
            modelRenderer = controller.splatRenderer
        case .sampleBox:
            modelRenderer = try! SampleBoxRenderer(device: device,
                                                   colorFormat: metalKitView.colorPixelFormat,
                                                   depthFormat: metalKitView.depthStencilPixelFormat,
                                                   sampleCount: metalKitView.sampleCount,
                                                   maxViewCount: 1,
                                                   maxSimultaneousRenders: Constants.maxSimultaneousRenders)
        case .none:
            break
        }
    }

    func setPointClickMode(_ enabled: Bool) {
        pointClickMode = enabled
        if enabled {
            lastPickedCoordinate = nil
            pointClickStatus = "Click a surface to read XYZ"
        } else {
            pointClickStatus = "Point Click off"
        }
        onPointClickStateChanged?()
    }

    /// Apply FPS-style look from a mouse / finger delta in points.
    func applyLookDelta(deltaX: CGFloat, deltaY: CGFloat) {
        cameraYaw += Float(deltaX) * Constants.cameraLookSensitivity
        cameraPitch -= Float(deltaY) * Constants.cameraLookSensitivity
        cameraPitch = max(-Constants.cameraPitchLimit, min(Constants.cameraPitchLimit, cameraPitch))
    }

    /// Pick the rendered surface under a click in view coordinates and store XYZ.
    func handlePointClick(at viewPoint: CGPoint) {
        guard pointClickMode else { return }

        guard let world = worldPosition(at: viewPoint) else {
            lastPickedCoordinate = nil
            pointClickStatus = "No surface at click"
            onPointClickStateChanged?()
            return
        }

        lastPickedCoordinate = world
        pointClickStatus = String(format: "X: %.3f   Y: %.3f   Z: %.3f", world.x, world.y, world.z)
        onPointClickStateChanged?()
    }

    private var cameraForward: SIMD3<Float> {
        let cosPitch = cos(cameraPitch)
        return SIMD3(
            sin(cameraYaw) * cosPitch,
            sin(cameraPitch),
            -cos(cameraYaw) * cosPitch
        )
    }

    private var cameraRight: SIMD3<Float> {
        simd_normalize(simd_cross(cameraForward, SIMD3<Float>(0, 1, 0)))
    }

    private var cameraUp: SIMD3<Float> {
        simd_normalize(simd_cross(cameraRight, cameraForward))
    }

    private var viewMatrix: matrix_float4x4 {
        let forward = cameraForward
        let right = cameraRight
        let up = cameraUp
        let eye = cameraPosition

        // World-to-view, looking down camera -Z.
        let rotationTranslation = matrix_float4x4(columns: (
            SIMD4(right.x, up.x, -forward.x, 0),
            SIMD4(right.y, up.y, -forward.y, 0),
            SIMD4(right.z, up.z, -forward.z, 0),
            SIMD4(-simd_dot(right, eye), -simd_dot(up, eye), simd_dot(forward, eye), 1)
        ))

        // Turn common 3D GS PLY files rightside-up.
        let commonUpCalibration = matrix4x4_rotation(radians: .pi, axis: SIMD3<Float>(0, 0, 1))
        return rotationTranslation * commonUpCalibration
    }

    private var projectionMatrix: matrix_float4x4 {
        matrix_perspective_right_hand(fovyRadians: Float(Constants.fovy.radians),
                                      aspectRatio: Float(drawableSize.width / max(drawableSize.height, 1)),
                                      nearZ: 0.1,
                                      farZ: 500.0)
    }

    private var viewport: ModelRendererViewportDescriptor {
        let viewport = MTLViewport(originX: 0, originY: 0, width: drawableSize.width, height: drawableSize.height, znear: 0, zfar: 1)

        return ModelRendererViewportDescriptor(viewport: viewport,
                                               projectionMatrix: projectionMatrix,
                                               viewMatrix: viewMatrix,
                                               screenSize: SIMD2(x: Int(drawableSize.width), y: Int(drawableSize.height)))
    }

    private func updateCamera() {
        let now = Date()
        defer { lastCameraUpdateTimestamp = now }

        guard let lastCameraUpdateTimestamp else { return }
        let deltaTime = Float(now.timeIntervalSince(lastCameraUpdateTimestamp))
        guard deltaTime > 0, movement.isActive else { return }

        // Ground-plane movement (FPS-style): ignore look pitch so forward never flies up/down.
        var forward = cameraForward
        forward.y = 0
        var right = cameraRight
        right.y = 0

        let forwardLength = simd_length(forward)
        let rightLength = simd_length(right)
        guard forwardLength > 0.0001, rightLength > 0.0001 else { return }
        forward /= forwardLength
        right /= rightLength

        var direction = SIMD3<Float>.zero
        if movement.forward { direction += forward }
        if movement.backward { direction -= forward }
        if movement.right { direction += right }
        if movement.left { direction -= right }

        let length = simd_length(direction)
        guard length > 0 else { return }
        cameraPosition += (direction / length) * Constants.cameraMoveSpeed * deltaTime
    }

    private func worldPosition(at viewPoint: CGPoint) -> SIMD3<Float>? {
        guard drawableSize.width > 0, drawableSize.height > 0 else { return nil }
        guard let depthTexture = metalKitView.depthStencilTexture else { return nil }
        guard let depthReadbackBuffer else { return nil }
        guard metalKitView.bounds.width > 0, metalKitView.bounds.height > 0 else { return nil }

        let scaleX = drawableSize.width / metalKitView.bounds.width
        let scaleY = drawableSize.height / metalKitView.bounds.height

        // Depth texture origin is top-left.
#if os(macOS)
        let pixelX = Int((viewPoint.x * scaleX).rounded(.down))
        let pixelY = Int(((metalKitView.bounds.height - viewPoint.y) * scaleY).rounded(.down))
#else
        let pixelX = Int((viewPoint.x * scaleX).rounded(.down))
        let pixelY = Int((viewPoint.y * scaleY).rounded(.down))
#endif

        let maxX = max(depthTexture.width - 1, 0)
        let maxY = max(depthTexture.height - 1, 0)
        guard pixelX >= 0, pixelY >= 0, pixelX <= maxX, pixelY <= maxY else { return nil }

        guard let commandBuffer = commandQueue.makeCommandBuffer(),
              let blit = commandBuffer.makeBlitCommandEncoder() else {
            return nil
        }

        blit.copy(from: depthTexture,
                  sourceSlice: 0,
                  sourceLevel: 0,
                  sourceOrigin: MTLOrigin(x: pixelX, y: pixelY, z: 0),
                  sourceSize: MTLSize(width: 1, height: 1, depth: 1),
                  to: depthReadbackBuffer,
                  destinationOffset: 0,
                  destinationBytesPerRow: MemoryLayout<Float>.size,
                  destinationBytesPerImage: MemoryLayout<Float>.size)
        blit.endEncoding()
        commandBuffer.commit()
        commandBuffer.waitUntilCompleted()

        let depth = depthReadbackBuffer.contents().assumingMemoryBound(to: Float.self).pointee
        // Renderer clears empty pixels to 0; treat near-zero as a miss.
        guard depth > 1e-4, depth.isFinite else { return nil }

        let ndcX = (2.0 * Float(pixelX) + 1.0) / Float(drawableSize.width) - 1.0
        let ndcY = 1.0 - (2.0 * Float(pixelY) + 1.0) / Float(drawableSize.height)
        let clip = SIMD4<Float>(ndcX, ndcY, depth, 1)
        let invViewProjection = (lastProjectionMatrix * lastViewMatrix).inverse
        let worldHomogeneous = invViewProjection * clip
        guard abs(worldHomogeneous.w) > 1e-6 else { return nil }
        let world = worldHomogeneous.xyz / worldHomogeneous.w
        guard world.x.isFinite, world.y.isFinite, world.z.isFinite else { return nil }
        return world
    }

    func draw(in view: MTKView) {
        guard let modelRenderer, modelRenderer.isReadyToRender else { return }
        guard let drawable = view.currentDrawable else { return }

        _ = inFlightSemaphore.wait(timeout: DispatchTime.distantFuture)

        guard let commandBuffer = commandQueue.makeCommandBuffer() else {
            inFlightSemaphore.signal()
            return
        }

        let semaphore = inFlightSemaphore
        commandBuffer.addCompletedHandler { (_ commandBuffer)-> Swift.Void in
            semaphore.signal()
        }

        updateCamera()
        proceduralSplatController?.update()

        lastProjectionMatrix = projectionMatrix
        lastViewMatrix = viewMatrix

        let didRender: Bool
        do {
            didRender = try modelRenderer.render(viewports: [viewport],
                                                 colorTexture: view.multisampleColorTexture ?? drawable.texture,
                                                 colorStoreAction: view.multisampleColorTexture == nil ? .store : .multisampleResolve,
                                                 depthTexture: view.depthStencilTexture,
                                                 rasterizationRateMap: nil,
                                                 renderTargetArrayLength: 0,
                                                 to: commandBuffer)
        } catch {
            Self.log.error("Unable to render scene: \(error.localizedDescription)")
            didRender = false
        }

        if didRender {
            commandBuffer.present(drawable)
        }

        commandBuffer.commit()
    }

    func mtkView(_ view: MTKView, drawableSizeWillChange size: CGSize) {
        drawableSize = size
    }
}

private extension SIMD4 where Scalar == Float {
    var xyz: SIMD3<Float> { SIMD3(x, y, z) }
}

#endif // os(iOS) || os(macOS)
