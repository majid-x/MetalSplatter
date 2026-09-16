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
        /// Used while recording stairs (Q / E or on-screen up/down).
        var up = false
        var down = false

        var isActive: Bool { forward || backward || left || right || up || down }
        var hasHorizontal: Bool { forward || backward || left || right }
    }

    private static let log =
        Logger(subsystem: Bundle.main.bundleIdentifier ?? "MetalSplatter.SampleApp",
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
    /// Photos returned for the latest point-click search.
    var searchedPhotos: [PhotoSearchResult] = []
    /// True while a photo API request is in flight.
    var isPhotoSearching = false

    /// When true, walk positions are sampled into `recordedCollisionPoints`.
    var isRecordingCollision = false
    /// World-space camera positions visited while recording (for walkable bounds).
    private(set) var recordedCollisionPoints: [SIMD3<Float>] = []
    private var lastRecordedCollisionPoint: SIMD3<Float>?

    /// When true, stair polygon vertices are placed manually (Mark Point).
    var isRecordingStairs = false
    /// Stair polygon corners (need ≥ 3). Y is height at that corner.
    private(set) var recordedStairPoints: [SIMD3<Float>] = []
    /// All active stair height regions (from package and/or marked polygons).
    private var stairRegions: [StairRegion] = []
    /// Standing height when off stairs. Only changes while walking on a stair region.
    private var persistentFloorY: Float = Constants.cameraGroundY

    private var lastCameraUpdateTimestamp: Date? = nil
    private var lastProjectionMatrix = matrix_identity_float4x4
    private var lastViewMatrix = matrix_identity_float4x4
    private var depthReadbackBuffer: MTLBuffer?
    private var photoSearchTask: Task<Void, Never>?
    private let photoSearchClient = PhotoSearchClient()
    /// Walkable region from scene package or a finished collision recording.
    private var walkableBounds: WalkableCollisionBounds? = nil
    /// Collision / stair source kept for Save / Download TXT.
    private var loadedCollisionPoints: [SIMD3<Float>] = []
    private var loadedStairPolygons: [[SIMD3<Float>]] = []
    /// Explicit start pose for Save / Download (Mark Start overwrites this).
    private var savedStartPosition = SIMD3<Float>(0, 0, Constants.cameraStartZ)
    private var savedStartYaw: Float = 0
    private var savedStartPitch: Float = 0
    var drawableSize: CGSize = .zero

    /// Notifies SwiftUI overlays when pick / mode / photo-search state changes.
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
        persistentFloorY = Constants.cameraGroundY
        walkableBounds = nil
        stairRegions = []
        loadedCollisionPoints = []
        loadedStairPolygons = []
        recordedCollisionPoints = []
        recordedStairPoints = []
        lastRecordedCollisionPoint = nil
        savedStartPosition = cameraPosition
        savedStartYaw = 0
        savedStartPitch = 0
        lastCameraUpdateTimestamp = nil
        lastPickedCoordinate = nil
        searchedPhotos = []
        isPhotoSearching = false
        photoSearchTask?.cancel()
        photoSearchTask = nil
        if pointClickMode {
            pointClickStatus = "Click a surface to find photos"
        } else {
            pointClickStatus = "Point Click off"
        }
        onPointClickStateChanged?()

        switch model {
        case .gaussianSplat(let url, let navigation):
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
            if let navigation {
                applyNavigation(navigation)
            }
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

    /// Apply start pose + collision + stairs from a scene package `nav.txt`.
    func applyNavigation(_ data: SceneNavigationData) {
        savedStartPosition = data.startPosition
        savedStartYaw = data.startYawRadians
        savedStartPitch = data.startPitchRadians
        cameraPosition = data.startPosition
        cameraYaw = data.startYawRadians
        cameraPitch = data.startPitchRadians
        persistentFloorY = data.startPosition.y

        loadedCollisionPoints = data.collisionPoints
        let clusters = data.collisionLayers.map { ($0.floorY, $0.points) }
        walkableBounds = WalkableCollisionBounds.fromClusters(clusters)

        loadedStairPolygons = data.stairPolygons.filter { $0.count >= 3 }
        rebuildStairRegions()

        applyStairOrGroundHeight()
    }

    /// Clear all collision layers and stop applying walkable clamp.
    func resetCollision() {
        setCollisionRecording(false)
        recordedCollisionPoints.removeAll(keepingCapacity: true)
        lastRecordedCollisionPoint = nil
        loadedCollisionPoints = []
        walkableBounds = nil
    }

    /// Clear all stair polygons and stop stair height following.
    func resetStairs() {
        setStairRecording(false)
        recordedStairPoints.removeAll(keepingCapacity: true)
        loadedStairPolygons = []
        stairRegions = []
        applyStairOrGroundHeight()
    }

    /// Overwrite the packaged start pose with the current camera.
    func markStartPoint() {
        savedStartPosition = cameraPosition
        savedStartYaw = cameraYaw
        savedStartPitch = cameraPitch
    }

    /// Commit any in-progress recording and apply collision / stairs / start live.
    func saveNavigation() {
        if isRecordingCollision {
            setCollisionRecording(false)
        }
        if isRecordingStairs {
            setStairRecording(false)
        }

        walkableBounds = WalkableCollisionBounds.fromPoints(loadedCollisionPoints)
        rebuildStairRegions()

        cameraPosition = savedStartPosition
        cameraYaw = savedStartYaw
        cameraPitch = savedStartPitch
        persistentFloorY = savedStartPosition.y
        applyStairOrGroundHeight()
    }

    private func rebuildStairRegions() {
        stairRegions = loadedStairPolygons.compactMap { StairRegion.make(vertices: $0) }
    }

    private func currentNavigationData() -> SceneNavigationData {
        var collision = loadedCollisionPoints
        if isRecordingCollision {
            collision += recordedCollisionPoints
        }

        var stairs = loadedStairPolygons
        if isRecordingStairs, recordedStairPoints.count >= 3 {
            stairs.append(recordedStairPoints)
        }

        return SceneNavigationData(
            startPosition: savedStartPosition,
            startYawRadians: savedStartYaw,
            startPitchRadians: savedStartPitch,
            collisionPoints: collision,
            stairPolygons: stairs
        )
    }

    func setPointClickMode(_ enabled: Bool) {
        pointClickMode = enabled
        if enabled {
            lastPickedCoordinate = nil
            searchedPhotos = []
            isPhotoSearching = false
            pointClickStatus = "Click a surface to find photos"
        } else {
            pointClickStatus = "Point Click off"
            photoSearchTask?.cancel()
            photoSearchTask = nil
            isPhotoSearching = false
        }
        onPointClickStateChanged?()
    }

    /// Apply FPS-style look from a mouse / finger delta in points.
    func applyLookDelta(deltaX: CGFloat, deltaY: CGFloat) {
        cameraYaw += Float(deltaX) * Constants.cameraLookSensitivity
        cameraPitch -= Float(deltaY) * Constants.cameraLookSensitivity
        cameraPitch = max(-Constants.cameraPitchLimit, min(Constants.cameraPitchLimit, cameraPitch))
    }

    func clearPhotoSearch() {
        photoSearchTask?.cancel()
        photoSearchTask = nil
        searchedPhotos = []
        isPhotoSearching = false
        if pointClickMode {
            pointClickStatus = lastPickedCoordinate.map {
                String(format: "X: %.3f   Y: %.3f   Z: %.3f", $0.x, $0.y, $0.z)
            } ?? "Click a surface to find photos"
        }
        onPointClickStateChanged?()
    }

    /// Start or stop sampling the camera path for a walkable collision region.
    func setCollisionRecording(_ enabled: Bool) {
        if enabled {
            setStairRecording(false)
        }
        isRecordingCollision = enabled
        if enabled {
            recordedCollisionPoints.removeAll(keepingCapacity: true)
            lastRecordedCollisionPoint = nil
            recordCollisionSampleIfNeeded(force: true)
        } else if recordedCollisionPoints.count >= 3 {
            // Merge with any previously loaded floors so ground + upper stay available.
            let merged = loadedCollisionPoints + recordedCollisionPoints
            loadedCollisionPoints = merged
            walkableBounds = WalkableCollisionBounds.fromPoints(merged)
        }
    }

    /// Combined nav.txt for packaging with a PLY inside a zip.
    func navigationExportText() -> String {
        currentNavigationData().serialize()
    }

    /// Plain-text export of recorded samples (one `x y z` per line).
    func collisionPathExportText() -> String? {
        guard !recordedCollisionPoints.isEmpty else { return nil }
        var lines: [String] = [
            "# MetalSplatter collision path",
            "# World-space camera XYZ samples (same frame as cam debug overlay)",
            "# One sample per line: x y z",
            "# min_spacing \(Constants.collisionSampleSpacing)",
        ]
        for p in recordedCollisionPoints {
            lines.append(String(format: "%.6f %.6f %.6f", p.x, p.y, p.z))
        }
        return lines.joined(separator: "\n") + "\n"
    }

    private func recordCollisionSampleIfNeeded(force: Bool = false) {
        guard isRecordingCollision else { return }
        let position = cameraPosition
        if !force, let last = lastRecordedCollisionPoint {
            if simd_distance(position, last) < Constants.collisionSampleSpacing {
                return
            }
        }
        recordedCollisionPoints.append(position)
        lastRecordedCollisionPoint = position
    }

    /// Start or stop stair polygon marking (click surface corners; Q/E moves the camera).
    func setStairRecording(_ enabled: Bool) {
        if enabled {
            setCollisionRecording(false)
        }
        isRecordingStairs = enabled
        if enabled {
            recordedStairPoints.removeAll(keepingCapacity: true)
        } else {
            commitStairRegionIfPossible()
        }
    }

    /// Place a stair polygon vertex at the world surface under the cursor.
    /// Converts depth-pick (model) coords into camera navigation space.
    @discardableResult
    func markStairPoint(at viewPoint: CGPoint) -> Bool {
        guard isRecordingStairs else { return false }
        guard let modelPoint = worldPosition(at: viewPoint) else { return false }
        let world = SplatNavigationSpace.fromModel(modelPoint)
        if let last = recordedStairPoints.last,
           simd_distance(last, world) < 0.02 {
            return false
        }
        recordedStairPoints.append(world)
        return true
    }

    /// Remove the last marked stair vertex.
    @discardableResult
    func undoStairPoint() -> Bool {
        guard isRecordingStairs, !recordedStairPoints.isEmpty else { return false }
        recordedStairPoints.removeLast()
        return true
    }

    /// Plain-text export of stair polygon vertices (one `x y z` per line).
    func stairPathExportText() -> String? {
        guard recordedStairPoints.count >= 3 else { return nil }
        var lines: [String] = [
            "# MetalSplatter stair region",
            "# Polygon vertices in order (triangle / quad / n-gon)",
            "# Height inside the area is interpolated from vertex Y values",
            "# Click surface corners in Stair Mode; Q/E only moves the camera",
            "# One vertex per line: x y z",
        ]
        for p in recordedStairPoints {
            lines.append(String(format: "%.6f %.6f %.6f", p.x, p.y, p.z))
        }
        return lines.joined(separator: "\n") + "\n"
    }

    private func commitStairRegionIfPossible() {
        guard recordedStairPoints.count >= 3,
              StairRegion.make(vertices: recordedStairPoints) != nil else { return }
        // Append on top of existing stair polygons (do not replace).
        loadedStairPolygons.append(recordedStairPoints)
        rebuildStairRegions()
        recordedStairPoints.removeAll(keepingCapacity: true)
        applyStairOrGroundHeight()
    }

    /// Pick the rendered surface under a click and search nearby source photos.
    func handlePointClick(at viewPoint: CGPoint) {
        guard pointClickMode else { return }

        guard let world = worldPosition(at: viewPoint) else {
            lastPickedCoordinate = nil
            searchedPhotos = []
            isPhotoSearching = false
            pointClickStatus = "No surface at click"
            onPointClickStateChanged?()
            return
        }

        lastPickedCoordinate = world
        pointClickStatus = String(format: "X: %.3f   Y: %.3f   Z: %.3f · searching…", world.x, world.y, world.z)
        searchedPhotos = []
        isPhotoSearching = true
        onPointClickStateChanged?()

        let camera = cameraPosition
        let forward = cameraForward
        photoSearchTask?.cancel()
        photoSearchTask = Task { [photoSearchClient] in
            do {
                let photos = try await photoSearchClient.search(
                    displayWorldPoint: world,
                    cameraPosition: camera,
                    viewDirection: forward,
                    maxResults: 6
                )
                guard !Task.isCancelled else { return }
                await MainActor.run {
                    self.searchedPhotos = photos
                    self.isPhotoSearching = false
                    self.pointClickStatus = String(
                        format: "X: %.3f   Y: %.3f   Z: %.3f · %d photos",
                        world.x, world.y, world.z, photos.count
                    )
                    self.onPointClickStateChanged?()
                }
            } catch {
                guard !Task.isCancelled else { return }
                await MainActor.run {
                    self.searchedPhotos = []
                    self.isPhotoSearching = false
                    self.pointClickStatus = String(
                        format: "X: %.3f   Y: %.3f   Z: %.3f · %@",
                        world.x, world.y, world.z, error.localizedDescription
                    )
                    self.onPointClickStateChanged?()
                }
            }
        }
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
        if length > 0 {
            let proposed = cameraPosition + (direction / length) * Constants.cameraMoveSpeed * deltaTime
            // While recording collision/stairs, allow free XZ.
            // Otherwise clamp using only the collision layer for the current camera height.
            if isRecordingCollision || isRecordingStairs {
                cameraPosition = proposed
            } else if let walkableBounds {
                cameraPosition = walkableBounds.clamp(proposed)
            } else {
                cameraPosition = proposed
            }
        }

        if isRecordingStairs {
            if movement.up {
                cameraPosition.y += Constants.stairRecordClimbSpeed * deltaTime
            }
            if movement.down {
                cameraPosition.y -= Constants.stairRecordClimbSpeed * deltaTime
            }
        } else if isRecordingCollision {
            recordCollisionSampleIfNeeded()
        } else {
            applyStairOrGroundHeight()
        }
    }

    private func applyStairOrGroundHeight() {
        if let height = stairRegions.lazy.compactMap({ $0.navigationHeight(at: self.cameraPosition) }).first {
            // On stairs: climb between that region's floors.
            persistentFloorY = height
            cameraPosition.y = height
        } else if !stairRegions.isEmpty {
            // Off stairs: stick to the nearer floor among all stair regions.
            let floors = stairRegions.flatMap { [$0.lowerFloorY, $0.upperFloorY] }
            if let nearest = floors.min(by: { abs($0 - persistentFloorY) < abs($1 - persistentFloorY) }) {
                persistentFloorY = nearest
            }
            cameraPosition.y = persistentFloorY
        } else {
            cameraPosition.y = persistentFloorY
        }
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

#endif // os(iOS) || os(macOS)
