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

    /// When true, click-to-place collision wall panels.
    var isPlacingCollisionBlocks = false
    /// When true, click selects a wall; drag resizes width/height.
    var isSelectingCollisionBlocks = false
    /// When true, walk positions are sampled into a walkable outline.
    var isRecordingCollision = false
    /// Solid wall panels (visible + obstacle collision).
    private(set) var collisionBlocks: [CollisionBlock] = []
    private(set) var selectedCollisionBlockIndex: Int? = nil
    /// Uniform cube size used when placing new blocks (editable in Add Block UI).
    var placementBlockSize: Float = Constants.collisionBlockWidth
    /// Ghost brick under the cursor while placing (optional).
    private var collisionBlockPreview: CollisionBlock? = nil
    private var lastCollisionPreviewUpdate: Date? = nil
    /// World-space camera positions visited while recording walk collision.
    private(set) var recordedCollisionPoints: [SIMD3<Float>] = []
    private var lastRecordedCollisionPoint: SIMD3<Float>?

    /// True while any collision authoring mode is active (blocks stay visible).
    var isCollisionEditingActive: Bool {
        isPlacingCollisionBlocks
            || isSelectingCollisionBlocks
            || isRecordingCollision
            || isRecordingClickCollision
    }

    /// When true, stair polygon vertices are placed manually (Mark Point).
    var isRecordingStairs = false
    /// Stair polygon corners (need ≥ 3). Y is height at that corner.
    private(set) var recordedStairPoints: [SIMD3<Float>] = []
    /// Four-click solid collision quads (Click Collision tool).
    var isRecordingClickCollision = false
    private(set) var recordedClickCollisionPoints: [SIMD3<Float>] = []
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
    /// Walkable region from scene package (legacy walked outline).
    private var walkableBounds: WalkableCollisionBounds? = nil
    /// Legacy walked samples kept for re-export of older packages.
    private var loadedCollisionPoints: [SIMD3<Float>] = []
    private var loadedStairPolygons: [[SIMD3<Float>]] = []
    /// Explicit start pose for Save / Download (Mark Start overwrites this).
    private var savedStartPosition = SIMD3<Float>(0, 0, Constants.cameraStartZ)
    private var savedStartYaw: Float = 0
    private var savedStartPitch: Float = 0
    /// World-space navigation frame. Default Y-up / -Z forward (legacy).
    private var navigationUp = SIMD3<Float>(0, 1, 0)
    private var navigationForward = SIMD3<Float>(0, 0, -1)
    /// When true, skip the built-in 180° Z splat calibration and use `navigationUp`/`navigationForward`.
    private var usesCustomOrientation = false
    /// Authoring mode: look around, then Save to lock this view as straight-ahead.
    var isSettingCameraAngles = false
    /// Authoring mode: position + height the spawn point, then Save.
    var isSettingStartPoint = false
    /// WASD / pad walk speed (m/s). Look sensitivity is separate and not stored here.
    var cameraMoveSpeed: Float = Constants.cameraMoveSpeed
    private var collisionBlockRenderer: CollisionBlockRenderer?
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
        collisionBlockRenderer = CollisionBlockRenderer(
            device: device,
            colorFormat: metalKitView.colorPixelFormat,
            depthFormat: metalKitView.depthStencilPixelFormat,
            sampleCount: metalKitView.sampleCount
        )
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
        collisionBlocks = []
        collisionBlockPreview = nil
        lastCollisionCursorPoint = nil
        selectedCollisionBlockIndex = nil
        isPlacingCollisionBlocks = false
        isSelectingCollisionBlocks = false
        isRecordingCollision = false
        recordedCollisionPoints = []
        lastRecordedCollisionPoint = nil
        recordedStairPoints = []
        recordedClickCollisionPoints = []
        isRecordingClickCollision = false
        savedStartPosition = cameraPosition
        savedStartYaw = 0
        savedStartPitch = 0
        navigationUp = SIMD3(0, 1, 0)
        navigationForward = SIMD3(0, 0, -1)
        usesCustomOrientation = false
        isSettingCameraAngles = false
        isSettingStartPoint = false
        cameraMoveSpeed = Constants.cameraMoveSpeed
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
        applyOrientation(
            up: data.orientationUp,
            forward: data.orientationForward
        )
        if let speed = data.moveSpeed, speed > 0 {
            cameraMoveSpeed = speed
        }
        cameraPosition = data.startPosition
        cameraYaw = data.startYawRadians
        cameraPitch = data.startPitchRadians
        persistentFloorY = heightAlongUp(data.startPosition)

        loadedCollisionPoints = data.collisionPoints
        let clusters = data.collisionLayers.map { ($0.floorY, $0.points) }
        walkableBounds = WalkableCollisionBounds.fromClusters(clusters)
        collisionBlocks = data.collisionBlocks
        collisionBlockPreview = nil
        selectedCollisionBlockIndex = nil

        loadedStairPolygons = data.stairPolygons.filter { $0.count >= 3 }
        rebuildStairRegions()

        applyStairOrGroundHeight()
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

    /// Clear all collision (walk outline + wall panels).
    func resetCollision() {
        setCollisionBlockPlacement(false)
        setCollisionBlockSelecting(false)
        setCollisionRecording(false)
        setClickCollisionRecording(false)
        loadedCollisionPoints = []
        recordedCollisionPoints = []
        lastRecordedCollisionPoint = nil
        walkableBounds = nil
        collisionBlocks = []
        collisionBlockPreview = nil
        selectedCollisionBlockIndex = nil
        recordedClickCollisionPoints = []
        isRecordingClickCollision = false
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
        persistentFloorY = heightAlongUp(cameraPosition)
    }

    func setCameraAnglesMode(_ enabled: Bool) {
        if enabled {
            setPointClickMode(false)
            setCollisionBlockPlacement(false)
            setCollisionBlockSelecting(false)
            setCollisionRecording(false)
            setClickCollisionRecording(false)
            setStairRecording(false)
            isSettingStartPoint = false
        }
        isSettingCameraAngles = enabled
    }

    func setStartPointMode(_ enabled: Bool) {
        if enabled {
            setPointClickMode(false)
            setCollisionBlockPlacement(false)
            setCollisionBlockSelecting(false)
            setCollisionRecording(false)
            setClickCollisionRecording(false)
            setStairRecording(false)
            isSettingCameraAngles = false
        } else if isSettingStartPoint {
            // Turning the mode off still commits the current pose/height.
            markStartPoint()
        }
        isSettingStartPoint = enabled
    }

    /// Nudge standing height along the navigation up axis (start-point authoring).
    func nudgeCameraHeight(_ deltaMeters: Float) {
        cameraPosition += navigationUp * deltaMeters
        persistentFloorY = heightAlongUp(cameraPosition)
    }

    /// Lock the current view as the straight-ahead frame only (does not change start point).
    func commitCameraOrientation() {
        // Bake the current view (including legacy splat calibration) into a navigation frame.
        let currentView = viewMatrix
        let inv = currentView.inverse
        var up = SIMD3(inv.columns.1.x, inv.columns.1.y, inv.columns.1.z)
        var forward = -SIMD3(inv.columns.2.x, inv.columns.2.y, inv.columns.2.z)

        let upLen = simd_length(up)
        guard upLen > 1e-5 else { return }
        up /= upLen
        forward = forward - simd_dot(forward, up) * up
        let forwardLen = simd_length(forward)
        guard forwardLen > 1e-5 else { return }
        forward /= forwardLen

        navigationUp = up
        navigationForward = forward
        usesCustomOrientation = true

        // Straight-ahead is identity in the new frame; leave start position alone.
        cameraYaw = 0
        cameraPitch = 0
        persistentFloorY = heightAlongUp(cameraPosition)
        lastViewMatrix = viewMatrix
        isSettingCameraAngles = false
    }

    /// Commit any in-progress recording and apply collision / stairs / start / speed live.
    func saveNavigation() {
        // Keep authored walk speed active immediately (also written into nav export).
        cameraMoveSpeed = max(0.001, cameraMoveSpeed)

        if isSettingCameraAngles {
            commitCameraOrientation()
        }
        // Always capture current camera as start while authoring the start point,
        // and also if height was adjusted (persistentFloor tracks that).
        if isSettingStartPoint {
            markStartPoint()
            isSettingStartPoint = false
        }

        if isPlacingCollisionBlocks {
            setCollisionBlockPlacement(false)
        }
        if isSelectingCollisionBlocks {
            setCollisionBlockSelecting(false)
        }
        if isRecordingCollision {
            setCollisionRecording(false)
        }
        if isRecordingClickCollision {
            setClickCollisionRecording(false)
        }
        if isRecordingStairs {
            setStairRecording(false)
        }

        walkableBounds = WalkableCollisionBounds.fromPoints(loadedCollisionPoints)
        rebuildStairRegions()

        // Restore the saved start pose exactly — do not snap height back via stairs/ground.
        cameraPosition = savedStartPosition
        cameraYaw = savedStartYaw
        cameraPitch = savedStartPitch
        persistentFloorY = heightAlongUp(savedStartPosition)
        setHeightAlongUp(persistentFloorY)
        let keepHeight = persistentFloorY
        let resolvedLocal = CollisionBlock.resolve(
            navigationBasis.toLocal(cameraPosition),
            against: collisionBlocks
        )
        cameraPosition = navigationBasis.toWorld(resolvedLocal)
        // Keep authored height even if block resolve nudged Y.
        setHeightAlongUp(keepHeight)
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
            orientationUp: usesCustomOrientation ? navigationUp : nil,
            orientationForward: usesCustomOrientation ? navigationForward : nil,
            moveSpeed: cameraMoveSpeed,
            collisionPoints: collision,
            collisionBlocks: collisionBlocks,
            stairPolygons: stairs
        )
    }

    func setPointClickMode(_ enabled: Bool) {
        if enabled {
            isSettingCameraAngles = false
            isSettingStartPoint = false
            setCollisionBlockPlacement(false)
            setCollisionBlockSelecting(false)
            setCollisionRecording(false)
            setClickCollisionRecording(false)
            setStairRecording(false)
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
        pointClickMode = enabled
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

    /// Start or stop click-to-place collision wall panels.
    func setCollisionBlockPlacement(_ enabled: Bool) {
        if enabled {
            setCollisionBlockSelecting(false)
            setCollisionRecording(false)
            setClickCollisionRecording(false)
            setStairRecording(false)
            setPointClickMode(false)
        }
        isPlacingCollisionBlocks = enabled
        if !enabled {
            collisionBlockPreview = nil
        }
    }

    /// Start or stop selecting / resizing placed wall panels (hides place ghost).
    func setCollisionBlockSelecting(_ enabled: Bool) {
        if enabled {
            setCollisionBlockPlacement(false)
            setCollisionRecording(false)
            setClickCollisionRecording(false)
            setStairRecording(false)
            setPointClickMode(false)
            collisionBlockPreview = nil
        } else {
            selectedCollisionBlockIndex = nil
        }
        isSelectingCollisionBlocks = enabled
    }

    /// Start or stop sampling the camera path for a walkable collision region.
    func setCollisionRecording(_ enabled: Bool) {
        if enabled {
            setCollisionBlockPlacement(false)
            setCollisionBlockSelecting(false)
            setClickCollisionRecording(false)
            setStairRecording(false)
            setPointClickMode(false)
            collisionBlockPreview = nil
        }
        isRecordingCollision = enabled
        if enabled {
            recordedCollisionPoints.removeAll(keepingCapacity: true)
            lastRecordedCollisionPoint = nil
            recordCollisionSampleIfNeeded(force: true)
        } else if recordedCollisionPoints.count >= 3 {
            let merged = loadedCollisionPoints + recordedCollisionPoints
            loadedCollisionPoints = merged
            walkableBounds = WalkableCollisionBounds.fromPoints(merged)
            recordedCollisionPoints.removeAll(keepingCapacity: true)
            lastRecordedCollisionPoint = nil
        }
    }

    /// Start or stop 3–4 click thin collision (surface corners → thin impassable barriers).
    func setClickCollisionRecording(_ enabled: Bool) {
        if enabled {
            setCollisionBlockPlacement(false)
            setCollisionBlockSelecting(false)
            setCollisionRecording(false)
            setStairRecording(false)
            setPointClickMode(false)
            collisionBlockPreview = nil
        }
        isRecordingClickCollision = enabled
        if enabled {
            recordedClickCollisionPoints.removeAll(keepingCapacity: true)
        } else {
            // Allow finishing a 3-point loop by turning the tool off.
            commitClickCollisionIfPossible(minimumPoints: 3)
            recordedClickCollisionPoints.removeAll(keepingCapacity: true)
            collisionBlockPreview = nil
        }
    }

    /// Mark one corner for Click Collision. Commits on the 4th point (or 3+ when mode ends).
    @discardableResult
    func markClickCollisionPoint(at viewPoint: CGPoint) -> Bool {
        guard isRecordingClickCollision else { return false }
        guard let world = cursorNavigationPoint(at: viewPoint) else { return false }
        if let last = recordedClickCollisionPoints.last,
           simd_distance(last, world) < 0.02 {
            return false
        }
        recordedClickCollisionPoints.append(world)
        updateClickCollisionPreview()
        if recordedClickCollisionPoints.count >= 4 {
            commitClickCollisionIfPossible(minimumPoints: 4)
        }
        return true
    }

    /// Remove the last Click Collision corner (or incomplete preview).
    @discardableResult
    func undoClickCollisionPoint() -> Bool {
        guard isRecordingClickCollision, !recordedClickCollisionPoints.isEmpty else { return false }
        recordedClickCollisionPoints.removeLast()
        updateClickCollisionPreview()
        return true
    }

    private func updateClickCollisionPreview() {
        guard recordedClickCollisionPoints.count >= 3 else {
            collisionBlockPreview = nil
            return
        }
        let walls = CollisionBlock.fromClickPoints(
            worldPoints: recordedClickCollisionPoints,
            basis: navigationBasis
        )
        collisionBlockPreview = walls.first
    }

    private func commitClickCollisionIfPossible(minimumPoints: Int) {
        guard recordedClickCollisionPoints.count >= minimumPoints else { return }
        let walls = CollisionBlock.fromClickPoints(
            worldPoints: recordedClickCollisionPoints,
            basis: navigationBasis
        )
        guard !walls.isEmpty else {
            recordedClickCollisionPoints.removeAll(keepingCapacity: true)
            collisionBlockPreview = nil
            return
        }
        for wall in walls where !collisionBlocks.contains(where: { $0.isSameCell(as: wall) }) {
            collisionBlocks.append(wall)
        }
        recordedClickCollisionPoints.removeAll(keepingCapacity: true)
        collisionBlockPreview = walls.first
    }

    /// Place a wall panel at the 3D point under the cursor.
    @discardableResult
    func placeCollisionBlock(at viewPoint: CGPoint) -> Bool {
        guard isPlacingCollisionBlocks else { return false }
        guard let world = cursorNavigationPoint(at: viewPoint) else { return false }
        let size = placementBlockSize
        let thickness = Constants.collisionBlockThickness(forFaceSize: size)
        let basis = navigationBasis
        let local = basis.toLocal(world)
        let block = CollisionBlock.placement(
            at: local,
            yawRadians: basis.facingYaw(cameraForward: cameraForward),
            existing: collisionBlocks,
            width: size,
            depth: thickness,
            height: size
        )
        if collisionBlocks.contains(where: { $0.isSameCell(as: block) }) { return false }
        collisionBlocks.append(block)
        collisionBlockPreview = block
        return true
    }

    /// Select the wall under the cursor via a view ray (overlays don't write depth).
    @discardableResult
    func selectCollisionBlock(at viewPoint: CGPoint) -> Bool {
        guard isSelectingCollisionBlocks else { return false }
        guard let (origin, direction) = navigationRay(at: viewPoint) else {
            selectedCollisionBlockIndex = nil
            return false
        }
        let basis = navigationBasis
        let originLocal = basis.toLocal(origin)
        let dirLocal = SIMD3(
            simd_dot(direction, basis.right),
            simd_dot(direction, basis.up),
            simd_dot(direction, -basis.forward)
        )
        selectedCollisionBlockIndex = CollisionBlock.hitTestRay(
            origin: originLocal,
            direction: dirLocal,
            in: collisionBlocks
        )
        return selectedCollisionBlockIndex != nil
    }

    /// Drag-resize the selected wall: horizontal → width, vertical → height.
    func resizeSelectedCollisionBlock(deltaX: CGFloat, deltaY: CGFloat) {
        guard isSelectingCollisionBlocks,
              let index = selectedCollisionBlockIndex,
              collisionBlocks.indices.contains(index) else { return }
        let sensitivity = Constants.collisionBlockResizeSensitivity
        var block = collisionBlocks[index]
        block.width = min(
            Constants.collisionBlockMaxWidth,
            max(Constants.collisionBlockMinWidth, block.width + Float(deltaX) * sensitivity)
        )
        block.height = min(
            Constants.collisionBlockMaxHeight,
            max(Constants.collisionBlockMinHeight, block.height - Float(deltaY) * sensitivity)
        )
        collisionBlocks[index] = block
    }

    /// Delete the currently selected wall.
    @discardableResult
    func deleteSelectedCollisionBlock() -> Bool {
        guard let index = selectedCollisionBlockIndex,
              collisionBlocks.indices.contains(index) else { return false }
        collisionBlocks.remove(at: index)
        selectedCollisionBlockIndex = nil
        return true
    }

    /// Remove the last placed collision wall.
    @discardableResult
    func undoCollisionBlock() -> Bool {
        guard !collisionBlocks.isEmpty else { return false }
        collisionBlocks.removeLast()
        if let selected = selectedCollisionBlockIndex {
            if selected >= collisionBlocks.count {
                selectedCollisionBlockIndex = nil
            }
        }
        return true
    }

    /// Update the translucent ghost wall under the cursor (place mode only).
    func updateCollisionBlockPreview(at viewPoint: CGPoint) {
        guard isPlacingCollisionBlocks else {
            collisionBlockPreview = nil
            return
        }
        let now = Date()
        if let lastCollisionPreviewUpdate,
           now.timeIntervalSince(lastCollisionPreviewUpdate) < 0.05 {
            return
        }
        lastCollisionPreviewUpdate = now
        guard let world = cursorNavigationPoint(at: viewPoint) else { return }
        let size = placementBlockSize
        let thickness = Constants.collisionBlockThickness(forFaceSize: size)
        let basis = navigationBasis
        let local = basis.toLocal(world)
        collisionBlockPreview = CollisionBlock.placement(
            at: local,
            yawRadians: basis.facingYaw(cameraForward: cameraForward),
            existing: collisionBlocks,
            width: size,
            depth: thickness,
            height: size
        )
    }

    /// Active FPS frame for block storage / collision (respects Set Camera Angles).
    private var navigationBasis: NavigationBasis {
        NavigationBasis(up: navigationUp, forward: navigationForward)
    }

    /// Depth unprojection is model-space only while the legacy splat calibration is in the view matrix.
    private func navigationPoint(fromDepthPick pick: SIMD3<Float>) -> SIMD3<Float> {
        usesCustomOrientation ? pick : SplatNavigationSpace.fromModel(pick)
    }

    /// 3D cursor in navigation space: prefer depth pick, else a ray fallthrough so placement stays free.
    private func cursorNavigationPoint(at viewPoint: CGPoint) -> SIMD3<Float>? {
        if let modelPoint = worldPosition(at: viewPoint) {
            let world = navigationPoint(fromDepthPick: modelPoint)
            lastCollisionCursorPoint = world
            return world
        }
        if let rayPoint = navigationPointOnViewRay(at: viewPoint, distance: lastCollisionCursorDistance) {
            lastCollisionCursorPoint = rayPoint
            return rayPoint
        }
        return lastCollisionCursorPoint
    }

    private var lastCollisionCursorPoint: SIMD3<Float>?
    private var lastCollisionCursorDistance: Float {
        guard let last = lastCollisionCursorPoint else { return 3.0 }
        return max(0.5, simd_length(last - cameraPosition))
    }

    /// Unproject a view pixel onto a point `distance` meters along the camera ray (nav space).
    private func navigationPointOnViewRay(at viewPoint: CGPoint, distance: Float) -> SIMD3<Float>? {
        guard let (origin, direction) = navigationRay(at: viewPoint) else { return nil }
        return origin + direction * distance
    }

    /// Camera ray through a view point, in navigation space.
    private func navigationRay(at viewPoint: CGPoint) -> (origin: SIMD3<Float>, direction: SIMD3<Float>)? {
        guard drawableSize.width > 0, drawableSize.height > 0 else { return nil }
        guard metalKitView.bounds.width > 0, metalKitView.bounds.height > 0 else { return nil }

        let scaleX = drawableSize.width / metalKitView.bounds.width
        let scaleY = drawableSize.height / metalKitView.bounds.height
#if os(macOS)
        let pixelX = Float(viewPoint.x * scaleX)
        let pixelY = Float((metalKitView.bounds.height - viewPoint.y) * scaleY)
#else
        let pixelX = Float(viewPoint.x * scaleX)
        let pixelY = Float(viewPoint.y * scaleY)
#endif

        let ndcX = (2.0 * pixelX) / Float(drawableSize.width) - 1.0
        let ndcY = 1.0 - (2.0 * pixelY) / Float(drawableSize.height)

        let forward = cameraForward
        let right = cameraRight
        let up = cameraUp
        let eye = cameraPosition
        let navView = matrix_float4x4(columns: (
            SIMD4(right.x, up.x, -forward.x, 0),
            SIMD4(right.y, up.y, -forward.y, 0),
            SIMD4(right.z, up.z, -forward.z, 0),
            SIMD4(-simd_dot(right, eye), -simd_dot(up, eye), simd_dot(forward, eye), 1)
        ))

        let clipNear = SIMD4<Float>(ndcX, ndcY, 1, 1)
        let inv = (projectionMatrix * navView).inverse
        let nearH = inv * clipNear
        guard abs(nearH.w) > 1e-6 else { return nil }
        let nearPoint = nearH.xyz / nearH.w
        var dir = nearPoint - eye
        let dirLen = simd_length(dir)
        guard dirLen > 1e-6 else { return (eye, forward) }
        dir /= dirLen
        return (eye, dir)
    }

    /// Combined nav.txt for packaging with a PLY inside a zip.
    func navigationExportText() -> String {
        currentNavigationData().serialize()
    }

    /// Plain-text export of recorded samples (one `x y z` per line).
    func collisionPathExportText() -> String? {
        let points = !recordedCollisionPoints.isEmpty ? recordedCollisionPoints : loadedCollisionPoints
        guard !points.isEmpty else { return nil }
        var lines: [String] = [
            "# MetalSplatter collision path",
            "# World-space camera XYZ samples (same frame as cam debug overlay)",
            "# One sample per line: x y z",
            "# min_spacing \(Constants.collisionSampleSpacing)",
        ]
        for p in points {
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
            setCollisionBlockPlacement(false)
            setCollisionBlockSelecting(false)
            setCollisionRecording(false)
            setClickCollisionRecording(false)
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
        let world = navigationPoint(fromDepthPick: modelPoint)
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

    private var navigationRight: SIMD3<Float> {
        let crossed = simd_cross(navigationForward, navigationUp)
        let len = simd_length(crossed)
        if len > 1e-5 {
            return crossed / len
        }
        // Degenerate fallback.
        let alt = abs(navigationUp.y) < 0.9 ? SIMD3<Float>(0, 1, 0) : SIMD3<Float>(1, 0, 0)
        return simd_normalize(simd_cross(navigationForward, alt))
    }

    private var cameraForward: SIMD3<Float> {
        let cosYaw = cos(cameraYaw)
        let sinYaw = sin(cameraYaw)
        let cosPitch = cos(cameraPitch)
        let sinPitch = sin(cameraPitch)
        // Yaw around navigation up, then pitch toward up.
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
            if isRecordingStairs || isSettingCameraAngles || isSettingStartPoint {
                // Free XZ while marking stairs / setting camera angles / start point.
                cameraPosition = proposed
            } else {
                var clamped = proposed
                // Walkable outline only when not actively recording a new walk path.
                if !isRecordingCollision, let walkableBounds {
                    clamped = walkableBounds.clamp(clamped)
                }
                // Solid wall panels: slide along faces — never teleport through.
                if isPlacingCollisionBlocks || isSelectingCollisionBlocks || isRecordingClickCollision {
                    cameraPosition = clamped
                } else {
                    let basis = navigationBasis
                    let moved = CollisionBlock.move(
                        from: basis.toLocal(cameraPosition),
                        to: basis.toLocal(clamped),
                        against: collisionBlocks
                    )
                    cameraPosition = basis.toWorld(moved)
                }
            }
        }

        if isRecordingStairs || isSettingCameraAngles || isSettingStartPoint {
            if movement.up {
                cameraPosition += navigationUp * Constants.stairRecordClimbSpeed * deltaTime
            }
            if movement.down {
                cameraPosition -= navigationUp * Constants.stairRecordClimbSpeed * deltaTime
            }
            if isSettingCameraAngles || isSettingStartPoint {
                persistentFloorY = heightAlongUp(cameraPosition)
            }
        } else if isRecordingCollision {
            recordCollisionSampleIfNeeded()
        } else {
            applyStairOrGroundHeight()
            // Block collision is XZ-only; never let it change standing height.
            setHeightAlongUp(persistentFloorY)
        }
    }

    private func applyStairOrGroundHeight() {
        if let height = stairRegions.lazy.compactMap({ $0.navigationHeight(at: self.cameraPosition) }).first {
            // On stairs: climb between that region's floors.
            persistentFloorY = height
            setHeightAlongUp(height)
        } else {
            // Off stairs (or no stairs): keep the authored / last floor height.
            // Do not snap to the nearest stair floor — that was resetting Set Start Point height.
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
            // Authoring only — hide walls after Save so the playable view stays clean.
            if isCollisionEditingActive {
                let colorTexture = view.multisampleColorTexture ?? drawable.texture
                collisionBlockRenderer?.draw(
                    blocks: collisionBlocks,
                    preview: (isPlacingCollisionBlocks || isRecordingClickCollision)
                        ? collisionBlockPreview : nil,
                    selectedIndex: isSelectingCollisionBlocks ? selectedCollisionBlockIndex : nil,
                    basis: navigationBasis,
                    applySplatFlip: !usesCustomOrientation,
                    viewProjection: lastProjectionMatrix * lastViewMatrix,
                    colorTexture: colorTexture,
                    depthTexture: view.depthStencilTexture,
                    to: commandBuffer
                )
            }
            commandBuffer.present(drawable)
        }

        commandBuffer.commit()
    }

    func mtkView(_ view: MTKView, drawableSizeWillChange size: CGSize) {
        drawableSize = size
    }
}

#endif // os(iOS) || os(macOS)
