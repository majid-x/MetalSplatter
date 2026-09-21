#if os(iOS) || os(macOS)

import Metal
import MetalKit
import MetalSplatter
import os
import SampleBoxRenderer
import simd
import SplatIO
import SwiftUI
#if os(macOS)
import AppKit
#endif

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
    /// Active stair height regions from the scene package.
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
    /// Solid wall panels from scene package `[blocks]`.
    private var collisionBlocks: [CollisionBlock] = []
    /// Collision / stair source points kept for "Download TXT" re-export.
    private var loadedCollisionPoints: [SIMD3<Float>] = []
    private var loadedStairPolygons: [[SIMD3<Float>]] = []
    /// World-space navigation frame (custom when nav.txt has `[orientation]`).
    private var navigationUp = SIMD3<Float>(0, 1, 0)
    private var navigationForward = SIMD3<Float>(0, 0, -1)
    private var usesCustomOrientation = false
    /// WASD walk speed (m/s); loaded from nav.txt `[settings]`.
    var cameraMoveSpeed: Float = Constants.cameraMoveSpeed
    var drawableSize: CGSize = .zero

    /// Notifies SwiftUI overlays when pick / mode / photo-search state changes.
    var onPointClickStateChanged: (() -> Void)?

    /// Filled on the next rendered frame when a product-search screenshot is requested.
    private var screenshotContinuation: CheckedContinuation<NSImage?, Never>?

    /// Captures the next presented frame as an `NSImage` (BGRA framebuffer readback).
    func captureScreenshotImage() async -> NSImage? {
        await withCheckedContinuation { continuation in
            screenshotContinuation?.resume(returning: nil)
            screenshotContinuation = continuation
        }
    }

    init?(_ metalKitView: MTKView) {
        self.device = metalKitView.device!
        guard let queue = self.device.makeCommandQueue() else { return nil }
        self.commandQueue = queue
        self.metalKitView = metalKitView
        metalKitView.colorPixelFormat = MTLPixelFormat.bgra8Unorm_srgb
        metalKitView.depthStencilPixelFormat = MTLPixelFormat.depth32Float
        metalKitView.sampleCount = 1
        metalKitView.clearColor = MTLClearColor(red: 0, green: 0, blue: 0, alpha: 0)
        // Required so drawable.texture can be blit/read for screenshots.
        metalKitView.framebufferOnly = false
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
        navigationUp = SIMD3(0, 1, 0)
        navigationForward = SIMD3(0, 0, -1)
        usesCustomOrientation = false
        cameraMoveSpeed = Constants.cameraMoveSpeed
        walkableBounds = nil
        stairRegions = []
        collisionBlocks = []
        loadedCollisionPoints = []
        loadedStairPolygons = []
        recordedCollisionPoints = []
        recordedStairPoints = []
        lastRecordedCollisionPoint = nil
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

    /// Apply start pose + orientation + walk speed + collision + stairs from a scene package `nav.txt`.
    func applyNavigation(_ data: SceneNavigationData) {
        // 1) Camera frame (custom orientation skips the legacy splat 180° flip).
        applyOrientation(up: data.orientationUp, forward: data.orientationForward)

        // 2) Walk speed from `[settings] move_speed`.
        if let speed = data.moveSpeed, speed > 0 {
            cameraMoveSpeed = max(0.001, speed)
        }

        // 3) Start pose from `[start]`.
        cameraPosition = data.startPosition
        cameraYaw = data.startYawRadians
        cameraPitch = data.startPitchRadians
        let startHeight = heightAlongUp(data.startPosition)
        persistentFloorY = startHeight

        // 4) Walkable outline layers from `[collision]` / `[collision floor=…]`.
        loadedCollisionPoints = data.collisionPoints
        let clusters = data.collisionLayers.map { ($0.floorY, $0.points) }
        walkableBounds = WalkableCollisionBounds.fromClusters(clusters)

        // 5) Solid walls from `[blocks]` (Add Block / Click Collision).
        collisionBlocks = data.collisionBlocks

        // 6) Stair polygons from one or more `[stairs]` sections.
        loadedStairPolygons = data.stairPolygons.filter { $0.count >= 3 }
        stairRegions = loadedStairPolygons.compactMap { StairRegion.make(vertices: $0) }

        applyStairOrGroundHeight()

        // Keep authored start height; only slide XZ out of solid walls.
        let keepHeight = heightAlongUp(data.startPosition)
        persistentFloorY = keepHeight
        let basis = NavigationBasis(up: navigationUp, forward: navigationForward)
        let resolvedLocal = CollisionBlock.resolve(
            basis.toLocal(cameraPosition),
            against: collisionBlocks
        )
        cameraPosition = basis.toWorld(resolvedLocal)
        setHeightAlongUp(keepHeight)
    }

    private func applyOrientation(up: SIMD3<Float>?, forward: SIMD3<Float>?) {
        guard let up, let forward else {
            navigationUp = SIMD3(0, 1, 0)
            navigationForward = SIMD3(0, 0, -1)
            usesCustomOrientation = false
            return
        }
        let upLen = simd_length(up)
        guard upLen > 1e-5 else {
            navigationUp = SIMD3(0, 1, 0)
            navigationForward = SIMD3(0, 0, -1)
            usesCustomOrientation = false
            return
        }
        let upN = up / upLen
        var forwardFlat = forward - simd_dot(forward, upN) * upN
        let forwardLen = simd_length(forwardFlat)
        guard forwardLen > 1e-5 else {
            navigationUp = SIMD3(0, 1, 0)
            navigationForward = SIMD3(0, 0, -1)
            usesCustomOrientation = false
            return
        }
        navigationUp = upN
        navigationForward = forwardFlat / forwardLen
        usesCustomOrientation = true
    }

    private func heightAlongUp(_ position: SIMD3<Float>) -> Float {
        simd_dot(position, navigationUp)
    }

    private func setHeightAlongUp(_ height: Float) {
        let current = heightAlongUp(cameraPosition)
        cameraPosition += (height - current) * navigationUp
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
        let collision = !recordedCollisionPoints.isEmpty ? recordedCollisionPoints : loadedCollisionPoints
        var stairs = loadedStairPolygons
        if recordedStairPoints.count >= 3 {
            stairs.append(recordedStairPoints)
        }
        return SceneNavigationData(
            startPosition: cameraPosition,
            startYawRadians: cameraYaw,
            startPitchRadians: cameraPitch,
            orientationUp: usesCustomOrientation ? navigationUp : nil,
            orientationForward: usesCustomOrientation ? navigationForward : nil,
            moveSpeed: cameraMoveSpeed,
            collisionPoints: collision,
            collisionBlocks: collisionBlocks,
            stairPolygons: stairs
        ).serialize()
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
        loadedStairPolygons.append(recordedStairPoints)
        stairRegions = loadedStairPolygons.compactMap { StairRegion.make(vertices: $0) }
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

    private var navigationRight: SIMD3<Float> {
        let crossed = simd_cross(navigationForward, navigationUp)
        let len = simd_length(crossed)
        if len > 1e-5 {
            return crossed / len
        }
        let alt = abs(navigationUp.y) < 0.9 ? SIMD3<Float>(0, 1, 0) : SIMD3<Float>(1, 0, 0)
        return simd_normalize(simd_cross(navigationForward, alt))
    }

    private var cameraForward: SIMD3<Float> {
        let cosYaw = cos(cameraYaw)
        let sinYaw = sin(cameraYaw)
        let cosPitch = cos(cameraPitch)
        let sinPitch = sin(cameraPitch)
        let yawed = simd_normalize(cosYaw * navigationForward + sinYaw * navigationRight)
        return simd_normalize(cosPitch * yawed + sinPitch * navigationUp)
    }

    private var cameraRight: SIMD3<Float> {
        let crossed = simd_cross(cameraForward, navigationUp)
        let len = simd_length(crossed)
        if len > 1e-5 {
            return crossed / len
        }
        return navigationRight
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

        if usesCustomOrientation {
            return rotationTranslation
        }
        // Turn common 3D GS PLY files rightside-up.
        let commonUpCalibration = matrix4x4_rotation(radians: .pi, axis: SIMD3<Float>(0, 0, 1))
        return rotationTranslation * commonUpCalibration
    }

    private var projectionMatrix: matrix_float4x4 {
        matrix_perspective_right_hand(fovyRadians: Float(Constants.fovy.radians),
                                      aspectRatio: Float(drawableSize.width / max(drawableSize.height, 1)),
                                      // Perspective near must be > 0; keep extremely close for indoor viewing.
                                      nearZ: 0.001,
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
        forward -= simd_dot(forward, navigationUp) * navigationUp
        var right = cameraRight
        right -= simd_dot(right, navigationUp) * navigationUp

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
            let proposed = cameraPosition + (direction / length) * cameraMoveSpeed * deltaTime
            if isRecordingCollision || isRecordingStairs {
                cameraPosition = proposed
            } else {
                var clamped = proposed
                if let walkableBounds {
                    clamped = walkableBounds.clamp(clamped)
                }
                let basis = NavigationBasis(up: navigationUp, forward: navigationForward)
                cameraPosition = basis.toWorld(
                    CollisionBlock.move(
                        from: basis.toLocal(cameraPosition),
                        to: basis.toLocal(clamped),
                        against: collisionBlocks
                    )
                )
            }
        }

        if isRecordingStairs {
            if movement.up {
                cameraPosition += navigationUp * Constants.stairRecordClimbSpeed * deltaTime
            }
            if movement.down {
                cameraPosition -= navigationUp * Constants.stairRecordClimbSpeed * deltaTime
            }
        } else if isRecordingCollision {
            recordCollisionSampleIfNeeded()
        } else {
            applyStairOrGroundHeight()
            setHeightAlongUp(persistentFloorY)
        }
    }

    private func applyStairOrGroundHeight() {
        if let height = stairRegions.lazy.compactMap({ $0.navigationHeight(at: self.cameraPosition) }).first {
            persistentFloorY = height
            setHeightAlongUp(height)
        } else {
            // Keep authored / last floor height; don't snap to nearest stair floor.
            setHeightAlongUp(persistentFloorY)
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
        guard let modelRenderer, modelRenderer.isReadyToRender else {
            failPendingScreenshot()
            return
        }
        guard let drawable = view.currentDrawable else { return }

        _ = inFlightSemaphore.wait(timeout: DispatchTime.distantFuture)

        guard let commandBuffer = commandQueue.makeCommandBuffer() else {
            inFlightSemaphore.signal()
            failPendingScreenshot()
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
            didRender = try modelRenderer.render(
                viewports: [viewport],
                colorTexture: view.multisampleColorTexture ?? drawable.texture,
                colorStoreAction: view.multisampleColorTexture == nil ? .store : .multisampleResolve,
                depthTexture: view.depthStencilTexture,
                rasterizationRateMap: nil,
                renderTargetArrayLength: 0,
                to: commandBuffer
            )
        } catch {
            Self.log.error("Unable to render scene: \(error.localizedDescription)")
            didRender = false
        }

        if didRender {
            if let continuation = screenshotContinuation {
                screenshotContinuation = nil
                // Prefer resolved MSAA texture when present; otherwise the drawable (now readable).
                let source = view.multisampleColorTexture ?? drawable.texture
                enqueueScreenshotReadback(
                    from: source,
                    commandBuffer: commandBuffer,
                    continuation: continuation
                )
            }
            commandBuffer.present(drawable)
        } else {
            failPendingScreenshot()
        }

        commandBuffer.commit()
    }

    private func failPendingScreenshot() {
        guard let continuation = screenshotContinuation else { return }
        screenshotContinuation = nil
        continuation.resume(returning: nil)
    }

    private func enqueueScreenshotReadback(
        from texture: MTLTexture,
        commandBuffer: MTLCommandBuffer,
        continuation: CheckedContinuation<NSImage?, Never>
    ) {
        let width = texture.width
        let height = texture.height
        guard width > 0, height > 0 else {
            continuation.resume(returning: nil)
            return
        }

        // Metal requires destination bytes-per-row alignment (typically 256 on Apple GPUs).
        let bytesPerPixel = 4
        let alignment = max(device.minimumLinearTextureAlignment(for: texture.pixelFormat), bytesPerPixel)
        let bytesPerRow = ((width * bytesPerPixel + alignment - 1) / alignment) * alignment
        let byteCount = bytesPerRow * height

        guard !texture.isFramebufferOnly else {
            Self.log.error("Screenshot source is framebufferOnly; set MTKView.framebufferOnly = false")
            continuation.resume(returning: nil)
            return
        }

        guard let buffer = device.makeBuffer(length: byteCount, options: .storageModeShared),
              let blit = commandBuffer.makeBlitCommandEncoder() else {
            continuation.resume(returning: nil)
            return
        }

        blit.copy(
            from: texture,
            sourceSlice: 0,
            sourceLevel: 0,
            sourceOrigin: MTLOrigin(x: 0, y: 0, z: 0),
            sourceSize: MTLSize(width: width, height: height, depth: 1),
            to: buffer,
            destinationOffset: 0,
            destinationBytesPerRow: bytesPerRow,
            destinationBytesPerImage: byteCount
        )
        blit.endEncoding()

        commandBuffer.addCompletedHandler { _ in
            let bgraData = Data(bytes: buffer.contents(), count: byteCount)
            let image = Self.makeNSImage(
                bgraData: bgraData,
                width: width,
                height: height,
                bytesPerRow: bytesPerRow
            )
            DispatchQueue.main.async {
                continuation.resume(returning: image)
            }
        }
    }

    nonisolated private static func makeNSImage(
        bgraData: Data,
        width: Int,
        height: Int,
        bytesPerRow: Int
    ) -> NSImage? {
        // Compact tightly packed RGBA for CGImage (source rows may be padded).
        var rgba = [UInt8](repeating: 0, count: width * height * 4)
        bgraData.withUnsafeBytes { raw in
            guard let src = raw.bindMemory(to: UInt8.self).baseAddress else { return }
            for y in 0..<height {
                for x in 0..<width {
                    let srcIndex = y * bytesPerRow + x * 4
                    let dstIndex = (y * width + x) * 4
                    // BGRA → RGBA
                    rgba[dstIndex + 0] = src[srcIndex + 2]
                    rgba[dstIndex + 1] = src[srcIndex + 1]
                    rgba[dstIndex + 2] = src[srcIndex + 0]
                    rgba[dstIndex + 3] = src[srcIndex + 3]
                }
            }
        }

        let packedBytesPerRow = width * 4
        let colorSpace = CGColorSpaceCreateDeviceRGB()
        guard let context = CGContext(
            data: &rgba,
            width: width,
            height: height,
            bitsPerComponent: 8,
            bytesPerRow: packedBytesPerRow,
            space: colorSpace,
            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
        ),
        let cgImage = context.makeImage() else {
            return nil
        }
        return NSImage(cgImage: cgImage, size: NSSize(width: width, height: height))
    }

    func mtkView(_ view: MTKView, drawableSizeWillChange size: CGSize) {
        drawableSize = size
    }
}

#endif // os(iOS) || os(macOS)
