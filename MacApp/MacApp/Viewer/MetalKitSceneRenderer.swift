#if os(iOS) || os(macOS) || os(visionOS)

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
    /// Per-project photo search API base URL from Supabase `photo_api`. Nil disables search.
    var photoAPIBaseURL: URL?
    /// From Supabase `spz` — inverted: off = send display as-is; on = apply 180° Z undo.
    var photoSearchUsesSPZCoordinates = false
    /// From Supabase `calibration` — PlayCanvas `useServerCalibration` (send raw display coords).
    var photoSearchUsesServerCalibration = false
    /// From Supabase `measur_factor`. Scales Measure distances (`display = raw * factor`).
    var measureCalibrationFactor: Float = 1.0
    /// Latest successfully picked world-space coordinate, if any.
    var lastPickedCoordinate: SIMD3<Float>?
    /// Same pick in model/depth-unprojection space (for drawing the marker with the splat view matrix).
    private var lastPickedModelCoordinate: SIMD3<Float>?
    /// Status line shown next to the Point Click UI.
    var pointClickStatus: String = "Search Image off"
    /// Photos returned for the latest point-click search.
    var searchedPhotos: [PhotoSearchResult] = []
    /// True while a photo API request is in flight.
    var isPhotoSearching = false
    /// PlayCanvas Fetch More: API reported more results available.
    var hasMorePhotos = false
    var isFetchingMorePhotos = false
    private var photoSearchMaxResults = PhotoSearchAPI.defaultMaxResults
    private var lastPhotoSearchCamera: SIMD3<Float>?
    private var lastPhotoSearchViewDirection: SIMD3<Float>?

    // MARK: - Measure (Windows / SuperSplat screen-space chrome + depth pick)
    var measureMode = false
    /// Measure pin snapping is disabled.
    private(set) var measureSnappingEnabled = false
    var measureDeleteMode = false
    var measureStatus: String = "Measure off"
    /// Screen-space distance labels for SwiftUI overlay.
    private(set) var measureLabelOverlays: [MeasureLabelOverlay] = []
    /// Windows-style screen pins / lasers / hover (SwiftUI), not world Metal meshes.
    private(set) var measurePinOverlays: [MeasurePinScreenOverlay] = []
    private(set) var measureLaserOverlays: [MeasureLaserScreenOverlay] = []
    private(set) var measureHoverOverlay: MeasureHoverScreenOverlay?
    /// Search Image screen pin + brief click flash (Windows mediaServer parity).
    private(set) var photoMarkerOverlay: PhotoMarkerScreenOverlay = PhotoMarkerScreenOverlay(
        pin: nil,
        flash: nil
    )
    /// MTKView bounds size used when projecting pins — SwiftUI scales chrome to match.
    private(set) var measureProjectionViewSize: CGSize = .zero
    private var measureNodes: [MeasureNode] = []
    private var measureHoverModelPoint: SIMD3<Float>?
    private var measureDeleteHoverIndex: Int?
    /// Last cursor in view coords (AppKit bottom-left on macOS; UIKit top-left on iOS).
    private var lastMeasureHoverViewPoint: CGPoint?
    private var lastMeasureHoverPickTime: CFTimeInterval = 0
    private var photoClickFlashViewPoint: CGPoint?
    private var photoClickFlashUntil: CFTimeInterval = 0
    private var measureOverlayRenderer: MeasureOverlayRenderer?
    var onMeasureStateChanged: (() -> Void)?
    /// Scales Measure pins, lasers, and hover reticle. Loaded from nav.txt `measure_scale`.
    var measureOverlayScale: Float = MeasureConstants.overlayScaleDefault {
        didSet {
            let clamped = min(
                MeasureConstants.overlayScaleMax,
                max(MeasureConstants.overlayScaleMin, measureOverlayScale)
            )
            if clamped != measureOverlayScale {
                measureOverlayScale = clamped
            }
        }
    }

    struct MeasureNode {
        /// Model / depth-unprojection space (for picks + projection).
        var modelPosition: SIMD3<Float>
        /// True when this pin opens a new 2-point chain (not linked to previous).
        var isStartOfChain: Bool
        /// Distance to previous linked node in meters (nil for chain starts).
        var distanceToPrevious: Float?
    }

    struct MeasureLabelOverlay: Identifiable, Equatable {
        let id: Int
        let viewPoint: CGPoint
        let text: String
    }

    struct MeasurePinScreenOverlay: Identifiable, Equatable {
        let id: Int
        let viewPoint: CGPoint
        let highlighted: Bool
    }

    struct MeasureLaserScreenOverlay: Identifiable, Equatable {
        let id: Int
        let start: CGPoint
        let end: CGPoint
        let preview: Bool
    }

    struct MeasureHoverScreenOverlay: Equatable {
        let viewPoint: CGPoint
    }

    struct PhotoMarkerScreenOverlay: Equatable {
        let pin: CGPoint?
        let flash: CGPoint?
    }

    private enum MeasureConstants {
        /// Windows mediaServer delete / hover screen radius (px × measure_scale).
        static let screenHitRadius: CGFloat = 28
        /// Hover pick throttle (~25 Hz), matching Windows ~40 ms.
        static let hoverPickInterval: CFTimeInterval = 0.04
        static let photoFlashDuration: CFTimeInterval = 0.35
        static let overlayScaleMin: Float = 0.05
        static let overlayScaleMax: Float = 2.0
        static let overlayScaleDefault: Float = 1.0
    }

    /// When true, walk positions are sampled into `recordedCollisionPoints`.
    var isRecordingCollision = false
    /// World-space camera positions visited while recording (for walkable bounds).
    private(set) var recordedCollisionPoints: [SIMD3<Float>] = []
    private var lastRecordedCollisionPoint: SIMD3<Float>?

    /// When true, stair polygon vertices are placed manually (Mark Point).
    var isRecordingStairs = false
    /// Stair polygon corners (need ≥ 3). Y is height at that corner.
    private(set) var recordedStairPoints: [SIMD3<Float>] = []
    /// Active stair height regions (from scene package and/or marked polygons).
    private var stairRegions: [StairRegion] = []
    /// Standing height when off stairs. Only changes while walking on a stair region.
    private var persistentFloorY: Float = Constants.cameraGroundY

    private var lastCameraUpdateTimestamp: Date? = nil
    private var lastProjectionMatrix = matrix_identity_float4x4
    private var lastViewMatrix = matrix_identity_float4x4
    /// SuperSplat-style stochastic pick target (RGBA16F, 4 survival trials of linear depth).
    private var pickTexture: MTLTexture?
    private var pickRenderCache: PickRenderCache?
    private var photoSearchTask: Task<Void, Never>?
    private let photoSearchClient = PhotoSearchClient()
    /// Walkable region from scene package or a finished collision recording.
    private var walkableBounds: WalkableCollisionBounds? = nil
    /// Solid wall panels from SampleApp `[blocks]` (world → collision via `navigationBasis`).
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

    private var navigationBasis: NavigationBasis {
        NavigationBasis(up: navigationUp, forward: navigationForward)
    }

    /// Notifies SwiftUI overlays when pick / mode / photo-search state changes.
    var onPointClickStateChanged: (() -> Void)?
    /// Notifies SwiftUI when Top Down availability / active state changes.
    var onTopDownStateChanged: (() -> Void)?

    // MARK: - Top Down (nav.txt authored cut — client view only)

    /// True when nav.txt includes a saved roof cut (`topdown_cut_height`).
    private(set) var hasTopDownCut = false
    private(set) var isTopDownActive = false
    private(set) var topDownStatus = "Top Down off"
    private var savedTopDownCutHeight: Float?
    private var savedTopDownOrthoHalfExtent: Float?
    private var savedTopDownOrthoZoomIn: Float?
    private var savedTopDownOrthoZoomOut: Float?
    private var savedTopDownYaw: Float?
    private var savedTopDownPitch: Float?
    private var savedTopDownCenter: SIMD3<Float>?
    private var topDownCutHeight: Float = 0
    private var topDownOrthoHalfExtent: Float = 10
    private var topDownSavedPosition = SIMD3<Float>.zero
    private var topDownSavedYaw: Float = 0
    private var topDownSavedPitch: Float = 0
    private var lastTopDownUINotifyTime: CFTimeInterval = 0

    /// Waits for the next frame readback; resumed at most once (timeout-safe).
    private final class ScreenshotWaiter {
        private var continuation: CheckedContinuation<PlatformImage?, Never>?

        func begin(_ continuation: CheckedContinuation<PlatformImage?, Never>) {
            finish(nil)
            self.continuation = continuation
        }

        var hasPending: Bool { continuation != nil }

        func finish(_ image: PlatformImage?) {
            guard let continuation else { return }
            self.continuation = nil
            if Thread.isMainThread {
                continuation.resume(returning: image)
            } else {
                DispatchQueue.main.async {
                    continuation.resume(returning: image)
                }
            }
        }
    }

    private let screenshotWaiter = ScreenshotWaiter()

    /// Cancels an in-flight screenshot wait (e.g. capture timeout).
    func cancelPendingScreenshot() {
        screenshotWaiter.finish(nil)
    }

    /// Captures the next presented frame as a `PlatformImage` (BGRA framebuffer readback).
    func captureScreenshotImage() async -> PlatformImage? {
#if os(macOS)
        metalKitView.setNeedsDisplay(metalKitView.bounds)
#else
        metalKitView.setNeedsDisplay()
#endif
        return await withCheckedContinuation { continuation in
            screenshotWaiter.begin(continuation)
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
        measureOverlayRenderer = MeasureOverlayRenderer(
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
        cameraMoveSpeed = Constants.cameraMoveSpeed
        walkableBounds = nil
        stairRegions = []
        collisionBlocks = []
        loadedCollisionPoints = []
        loadedStairPolygons = []
        recordedCollisionPoints = []
        recordedStairPoints = []
        lastRecordedCollisionPoint = nil
        navigationUp = SIMD3(0, 1, 0)
        navigationForward = SIMD3(0, 0, -1)
        usesCustomOrientation = false
        lastCameraUpdateTimestamp = nil
        lastPickedCoordinate = nil
        lastPickedModelCoordinate = nil
        pickTexture = nil
        pickRenderCache = nil
        searchedPhotos = []
        isPhotoSearching = false
        isFetchingMorePhotos = false
        hasMorePhotos = false
        photoSearchMaxResults = PhotoSearchAPI.defaultMaxResults
        lastPhotoSearchCamera = nil
        lastPhotoSearchViewDirection = nil
        photoSearchTask?.cancel()
        photoSearchTask = nil
        clearMeasureGeometry()
        measureMode = false
        measureDeleteMode = false
        measureStatus = "Measure off"
        measureOverlayScale = MeasureConstants.overlayScaleDefault
        measureSnappingEnabled = false
        clearTopDownState()
        if pointClickMode {
            pointClickStatus = "Click a surface to find photos"
        } else {
            pointClickStatus = "Search Image off"
        }
        onPointClickStateChanged?()
        onMeasureStateChanged?()
        onTopDownStateChanged?()

        switch model {
        case .gaussianSplat(let url, let navigation):
            let splat = try SplatRenderer(device: device,
                                          colorFormat: metalKitView.colorPixelFormat,
                                          depthFormat: metalKitView.depthStencilPixelFormat,
                                          sampleCount: metalKitView.sampleCount,
                                          maxViewCount: 1,
                                          maxSimultaneousRenders: Constants.maxSimultaneousRenders,
                                          highQualityDepth: false)
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

    /// Apply start pose + collision + stairs strictly from a scene package `nav.txt`.
    /// Missing sections stay empty — no synthetic walkable bounds, blocks, or stairs.
    func applyNavigation(_ data: SceneNavigationData) {
        applyOrientation(up: data.orientationUp, forward: data.orientationForward)
        // Walk speed comes from Supabase `move_speed`, not nav.txt.
        if let scale = data.measureScale, scale > 0 {
            measureOverlayScale = scale
        }
        cameraPosition = data.startPosition
        cameraYaw = data.startYawRadians
        cameraPitch = data.startPitchRadians
        persistentFloorY = heightAlongUp(data.startPosition)

        loadedCollisionPoints = data.collisionPoints
        let clusters = data.collisionLayers.map { ($0.floorY, $0.points) }
        // Empty clusters → nil bounds (free XZ). Never invent a walkable polygon.
        walkableBounds = clusters.isEmpty ? nil : WalkableCollisionBounds.fromClusters(clusters)
        collisionBlocks = data.collisionBlocks

        loadedStairPolygons = data.stairPolygons.filter { $0.count >= 3 }
        rebuildStairRegions()

        // Store authored top-down cut for the Top Down tool (does not auto-enter).
        if let cutHeight = data.topDownCutHeight {
            hasTopDownCut = true
            savedTopDownCutHeight = cutHeight
            savedTopDownOrthoHalfExtent = data.topDownOrthoHalfExtent
            savedTopDownOrthoZoomIn = data.topDownOrthoZoomIn
            savedTopDownOrthoZoomOut = data.topDownOrthoZoomOut
            savedTopDownYaw = data.topDownYawRadians
            savedTopDownPitch = data.topDownPitchRadians
            savedTopDownCenter = data.topDownCenter
        } else {
            clearTopDownState()
        }

        applyStairOrGroundHeight()
        onTopDownStateChanged?()
    }

    private func clearTopDownState() {
        if isTopDownActive {
            (modelRenderer as? SplatRenderer)?.modelClipPlane = nil
        }
        hasTopDownCut = false
        isTopDownActive = false
        topDownStatus = "Top Down off"
        savedTopDownCutHeight = nil
        savedTopDownOrthoHalfExtent = nil
        savedTopDownOrthoZoomIn = nil
        savedTopDownOrthoZoomOut = nil
        savedTopDownYaw = nil
        savedTopDownPitch = nil
        savedTopDownCenter = nil
        topDownCutHeight = 0
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

    private func rebuildStairRegions() {
        stairRegions = loadedStairPolygons.compactMap { StairRegion.make(vertices: $0) }
    }

    func setPointClickMode(_ enabled: Bool) {
        guard photoAPIBaseURL != nil || !enabled else {
            pointClickMode = false
            pointClickStatus = "Search Image off"
            onPointClickStateChanged?()
            return
        }
        if enabled {
            setMeasureMode(false)
            if isTopDownActive { setTopDownMode(false) }
        }
        pointClickMode = enabled
        if enabled {
            lastPickedCoordinate = nil
            lastPickedModelCoordinate = nil
            searchedPhotos = []
            isPhotoSearching = false
            isFetchingMorePhotos = false
            hasMorePhotos = false
            photoSearchMaxResults = PhotoSearchAPI.defaultMaxResults
            lastPhotoSearchCamera = nil
            lastPhotoSearchViewDirection = nil
            photoClickFlashViewPoint = nil
            photoClickFlashUntil = 0
            pointClickStatus = "Click a surface to find photos"
        } else {
            lastPickedModelCoordinate = nil
            photoClickFlashViewPoint = nil
            photoClickFlashUntil = 0
            pointClickStatus = "Search Image off"
            photoSearchTask?.cancel()
            photoSearchTask = nil
            isPhotoSearching = false
            isFetchingMorePhotos = false
            hasMorePhotos = false
        }
        refreshMeasureScreenChrome()
        onPointClickStateChanged?()
    }

    // MARK: Measure tool

    func setMeasureMode(_ enabled: Bool) {
        if enabled {
            setPointClickMode(false)
            if isTopDownActive { setTopDownMode(false) }
        }
        measureMode = enabled
        measureDeleteMode = false
        measureHoverModelPoint = nil
        measureDeleteHoverIndex = nil
        lastMeasureHoverViewPoint = nil
        lastMeasureHoverPickTime = 0
        measureHoverOverlay = nil
        if enabled {
            measureStatus = "Measure on · click two points"
        } else {
            // Keep placed pins/distances; Delete All clears. Drop hover/reticle only.
            measureStatus = measureNodes.isEmpty
                ? "Measure off"
                : String(format: "Measure off · %d points kept", measureNodes.count)
        }
        refreshMeasureScreenChrome()
        onMeasureStateChanged?()
        onPointClickStateChanged?()
    }

    func setMeasureSnappingEnabled(_ enabled: Bool) {
        // Snapping is permanently off.
        measureSnappingEnabled = false
        onMeasureStateChanged?()
    }

    func setMeasureDeleteMode(_ enabled: Bool) {
        guard measureMode else { return }
        measureDeleteMode = enabled
        measureDeleteHoverIndex = nil
        measureStatus = enabled ? "Delete mode · click a pin" : "Measure on · click two points"
        onMeasureStateChanged?()
    }

    @discardableResult
    func undoMeasurePoint() -> Bool {
        guard !measureNodes.isEmpty else { return false }
        measureNodes.removeLast()
        if measureNodes.isEmpty {
            measureStatus = measureMode ? "Measure on · click two points" : "Measure off"
        } else if measureNodes.last?.isStartOfChain == true {
            measureStatus = String(format: "Undid point · click second point · %d left", measureNodes.count)
        } else {
            measureStatus = String(format: "Undid point · %d left", measureNodes.count)
        }
        refreshMeasureScreenChrome()
        onMeasureStateChanged?()
        return true
    }

    func clearMeasureGeometry() {
        measureNodes.removeAll(keepingCapacity: true)
        measureHoverModelPoint = nil
        measureDeleteHoverIndex = nil
        lastMeasureHoverViewPoint = nil
        measureLabelOverlays = []
        measurePinOverlays = []
        measureLaserOverlays = []
        measureHoverOverlay = nil
        measureDeleteMode = false
        measureStatus = measureMode ? "Cleared · Measure on · click two points" : "Measure off"
        refreshMeasureScreenChrome()
        onMeasureStateChanged?()
    }

    /// Windows-style hover — cursor ring always tracks the pointer; depth pick for preview laser.
    func updateMeasureHover(at viewPoint: CGPoint) {
        guard measureMode else { return }
        lastMeasureHoverViewPoint = viewPoint
        pickMeasureHover(at: viewPoint, force: false)
        refreshMeasureScreenChrome()
        onMeasureStateChanged?()
    }

    private func pickMeasureHover(at viewPoint: CGPoint, force: Bool) {
        guard measureMode else { return }
        let now = CACurrentMediaTime()
        if !force, now - lastMeasureHoverPickTime < MeasureConstants.hoverPickInterval { return }
        lastMeasureHoverPickTime = now

        if measureDeleteMode {
            measureDeleteHoverIndex = nearestMeasureNodeIndex(
                atViewPoint: viewPoint,
                screenRadius: MeasureConstants.screenHitRadius
            )
            measureHoverModelPoint = measureDeleteHoverIndex.map { measureNodes[$0].modelPosition }
            return
        }

        measureDeleteHoverIndex = nil
        measureHoverModelPoint = worldPosition(at: viewPoint)
    }

    func handleMeasureClick(at viewPoint: CGPoint) {
        guard measureMode else { return }

        if measureDeleteMode {
            if let index = measureDeleteHoverIndex
                ?? nearestMeasureNodeIndex(
                    atViewPoint: viewPoint,
                    screenRadius: MeasureConstants.screenHitRadius
                ) {
                deleteMeasureNode(at: index)
                measureDeleteMode = false
                measureDeleteHoverIndex = nil
                measureStatus = "Deleted pin · Measure on"
                refreshMeasureScreenChrome()
                onMeasureStateChanged?()
            } else {
                measureStatus = "No pin near click"
                onMeasureStateChanged?()
            }
            return
        }

        // Same alpha-clipped pick pass as Point Click / hover.
        guard let modelPoint = worldPosition(at: viewPoint) else {
            measureStatus = "No surface at click"
            onMeasureStateChanged?()
            return
        }

        addMeasurePoint(modelPoint)
    }

    private func addMeasurePoint(_ modelPoint: SIMD3<Float>) {
        // Fixed 2-click chains (Windows): open start → complete segment → next click starts a new chain.
        // No FOV gate — Mac previously refused links outside 60°.
        let isStart: Bool
        var distance: Float?
        if let previous = measureNodes.last, previous.isStartOfChain {
            isStart = false
            distance = simd_distance(previous.modelPosition, modelPoint) * measureCalibrationFactor
        } else {
            isStart = true
        }

        measureNodes.append(MeasureNode(
            modelPosition: modelPoint,
            isStartOfChain: isStart,
            distanceToPrevious: distance
        ))

        if let distance {
            measureStatus = "Segment \(Self.formatMeasureDistance(meters: distance)) · \(measureNodes.count) points"
        } else {
            measureStatus = String(format: "Point placed · click second point · %d points", measureNodes.count)
        }
        refreshMeasureScreenChrome()
        onMeasureStateChanged?()
    }

    private func deleteMeasureNode(at index: Int) {
        guard measureNodes.indices.contains(index) else { return }
        measureNodes.remove(at: index)
        rebuildMeasureChainDistances()
        refreshMeasureScreenChrome()
    }

    private func rebuildMeasureChainDistances() {
        guard measureNodes.count >= 2 else {
            if let first = measureNodes.indices.first {
                measureNodes[first].isStartOfChain = true
                measureNodes[first].distanceToPrevious = nil
            }
            return
        }
        measureNodes[0].isStartOfChain = true
        measureNodes[0].distanceToPrevious = nil
        for i in 1..<measureNodes.count {
            if measureNodes[i].isStartOfChain {
                measureNodes[i].distanceToPrevious = nil
            } else {
                let prev = measureNodes[i - 1].modelPosition
                let cur = measureNodes[i].modelPosition
                measureNodes[i].distanceToPrevious = simd_distance(prev, cur) * measureCalibrationFactor
            }
        }
    }

    /// Windows: delete hit-test in screen px (`28 * measure_scale`), not world meters.
    private func nearestMeasureNodeIndex(atViewPoint viewPoint: CGPoint, screenRadius: CGFloat) -> Int? {
        let cursor = viewPointInSwiftUISpace(viewPoint)
        let radius = screenRadius * CGFloat(measureOverlayScale)
        var bestIndex: Int?
        var bestDistance = radius
        for (index, node) in measureNodes.enumerated() {
            guard let screen = projectModelPointToView(node.modelPosition) else { continue }
            let d = hypot(screen.x - cursor.x, screen.y - cursor.y)
            if d <= bestDistance {
                bestDistance = d
                bestIndex = index
            }
        }
        return bestIndex
    }

    /// Convert MTKView click/hover coords into SwiftUI `.position` space (top-left origin).
    private func viewPointInSwiftUISpace(_ viewPoint: CGPoint) -> CGPoint {
#if os(macOS)
        return CGPoint(x: viewPoint.x, y: metalKitView.bounds.height - viewPoint.y)
#else
        return viewPoint
#endif
    }

    /// Refresh SwiftUI labels + Windows-style cursor pointer (dual ring + dashed preview).
    private func refreshMeasureScreenChrome() {
        var labels: [MeasureLabelOverlay] = []
        var lasers: [MeasureLaserScreenOverlay] = []
        measureProjectionViewSize = metalKitView.bounds.size

        // Distance labels stay visible after leaving Measure (pins stay in Metal).
        if measureNodes.count >= 2 {
            for i in 1..<measureNodes.count {
                let node = measureNodes[i]
                guard !node.isStartOfChain, let distance = node.distanceToPrevious else { continue }
                let prev = measureNodes[i - 1].modelPosition
                let mid = (prev + node.modelPosition) * 0.5
                guard let screen = projectModelPointToView(mid) else { continue }
                labels.append(MeasureLabelOverlay(
                    id: i,
                    viewPoint: screen,
                    text: Self.formatMeasureDistance(meters: distance)
                ))
            }
        }

        // Windows: dual-ring always tracks the cursor (even if surface pick misses).
        if measureMode, let hoverView = lastMeasureHoverViewPoint {
            let hoverScreen = viewPointInSwiftUISpace(hoverView)
            measureHoverOverlay = MeasureHoverScreenOverlay(viewPoint: hoverScreen)
            if !measureDeleteMode,
               let last = measureNodes.last,
               last.isStartOfChain,
               let a = projectModelPointToView(last.modelPosition) {
                lasers.append(MeasureLaserScreenOverlay(
                    id: -1,
                    start: a,
                    end: hoverScreen,
                    preview: true
                ))
            }
        } else {
            measureHoverOverlay = nil
        }

        measureLabelOverlays = labels
        measureLaserOverlays = lasers
        measurePinOverlays = []
        photoMarkerOverlay = PhotoMarkerScreenOverlay(pin: nil, flash: nil)
    }

    /// Imperial distance: `feet' inches fraction"`.
    /// Default rounds to nearest 1/4". Exact mode (Settings) uses 1/32".
    private static func formatMeasureDistance(meters: Float) -> String {
        let totalFeet = Double(meters) * 3.280839895
        var feet = Int(floor(totalFeet))
        let remainingInches = (totalFeet - Double(feet)) * 12.0
        var inches = Int(floor(remainingInches))
        let fractionOfInch = remainingInches - Double(inches)

        let denominator = MeasurementDisplayPreferences.showExactMeasurements ? 32 : 4
        var numerator = Int((fractionOfInch * Double(denominator)).rounded())
        if numerator == denominator {
            numerator = 0
            inches += 1
        }
        if inches >= 12 {
            inches -= 12
            feet += 1
        }

        var fractionStr = ""
        if numerator > 0 {
            let divisor = gcd(numerator, denominator)
            fractionStr = " \(numerator / divisor)/\(denominator / divisor)"
        }

        return "\(feet)' \(inches)\(fractionStr)\""
    }

    private static func gcd(_ a: Int, _ b: Int) -> Int {
        var x = abs(a)
        var y = abs(b)
        while y != 0 {
            let t = x % y
            x = y
            y = t
        }
        return max(x, 1)
    }

    private func projectModelPointToView(_ modelPoint: SIMD3<Float>) -> CGPoint? {
        guard drawableSize.width > 1, drawableSize.height > 1 else { return nil }
        let clip = lastProjectionMatrix * lastViewMatrix * SIMD4(modelPoint.x, modelPoint.y, modelPoint.z, 1)
        // Windows `worldToScreen`: view-space z >= 0 is behind the camera → hide.
        guard clip.w > Constants.pickNearClip else { return nil }
        let ndc = clip.xyz / clip.w
        let bounds = metalKitView.bounds
        guard bounds.width > 1, bounds.height > 1 else { return nil }
        measureProjectionViewSize = bounds.size
        let x = CGFloat((ndc.x + 1) * 0.5) * bounds.width
        // SwiftUI `.position` uses top-left origin on every platform (not AppKit bottom-left).
        let y = CGFloat((1 - ndc.y) * 0.5) * bounds.height
        return CGPoint(x: x, y: y)
    }


    /// Apply FPS-style look from a mouse / finger delta in points.
    func applyLookDelta(deltaX: CGFloat, deltaY: CGFloat) {
        cameraYaw += Float(deltaX) * Constants.cameraLookSensitivity
        cameraPitch -= Float(deltaY) * Constants.cameraLookSensitivity
        cameraPitch = max(-Constants.cameraPitchLimit, min(Constants.cameraPitchLimit, cameraPitch))
    }

    // MARK: Top Down View (from nav.txt)

    /// Enter / leave the authored roof-cut top-down view. Only valid when `hasTopDownCut`.
    func setTopDownMode(_ enabled: Bool) {
        if enabled {
            guard hasTopDownCut, let cutHeight = savedTopDownCutHeight else { return }
            if isTopDownActive { return }
            setPointClickMode(false)
            setMeasureMode(false)

            topDownSavedPosition = cameraPosition
            topDownSavedYaw = cameraYaw
            topDownSavedPitch = cameraPitch

            topDownCutHeight = cutHeight
            applyTopDownStartPose()

            isTopDownActive = true
            syncTopDownClipPlane()
            topDownStatus = String(
                format: "Top Down · roof %.2f m · zoom in to cut · zoom out capped by nav",
                topDownCutHeight
            )
        } else {
            guard isTopDownActive else { return }
            isTopDownActive = false
            topDownStatus = "Top Down off"
            (modelRenderer as? SplatRenderer)?.modelClipPlane = nil
            cameraPosition = topDownSavedPosition
            cameraYaw = topDownSavedYaw
            cameraPitch = topDownSavedPitch
            persistentFloorY = heightAlongUp(cameraPosition)
            applyStairOrGroundHeight()
        }
        onTopDownStateChanged?()
    }

    /// Restore camera to the authored top-down start pose from nav.txt.
    func resetTopDownView() {
        guard isTopDownActive, hasTopDownCut, let cutHeight = savedTopDownCutHeight else { return }
        topDownCutHeight = cutHeight
        applyTopDownStartPose()
        syncTopDownClipPlane()
        topDownStatus = String(
            format: "Top Down reset · roof %.2f m",
            topDownCutHeight
        )
        onTopDownStateChanged?()
    }

    private func applyTopDownStartPose() {
        if let ortho = savedTopDownOrthoHalfExtent, ortho > 0 {
            topDownOrthoHalfExtent = ortho
        } else if let zout = savedTopDownOrthoZoomOut, zout > 0 {
            topDownOrthoHalfExtent = zout
        }

        if let yaw = savedTopDownYaw { cameraYaw = yaw }
        if let pitch = savedTopDownPitch { cameraPitch = pitch }
        if let center = savedTopDownCenter {
            cameraPosition = center
        } else {
            cameraPitch = -Constants.cameraPitchLimit
            setHeightAlongUp(topDownCutHeight + topDownHoverDistance(for: topDownOrthoHalfExtent))
        }
        clampTopDownZoomToLimits()
    }

    /// Zoom in / out along navigation up (buttons). Zoom in toward cut; zoom out to nav max.
    func nudgeTopDownZoom(zoomIn: Bool) {
        guard isTopDownActive else { return }
        let heightAbove = max(0.001, heightAlongUp(cameraPosition) - topDownCutHeight)
        // ~20% of current height per click, floored so it still moves when close.
        let step = max(0.08, heightAbove * 0.2)
        if zoomIn {
            setHeightAlongUp(heightAlongUp(cameraPosition) - step)
        } else {
            setHeightAlongUp(heightAlongUp(cameraPosition) + step)
        }
        clampTopDownZoomToLimits()
        topDownStatus = String(
            format: "Top Down · roof %.2f m · view %.2f m",
            topDownCutHeight,
            topDownOrthoHalfExtent
        )
        onTopDownStateChanged?()
    }

    private func topDownHoverDistance(for halfExtent: Float) -> Float {
        let fovy = Float(Constants.fovy.radians)
        return max(0.001, halfExtent / max(1e-4, tan(fovy * 0.5)))
    }

    private func refreshTopDownOrthoFromCamera() {
        let heightAboveCut = abs(heightAlongUp(cameraPosition) - topDownCutHeight)
        let fovy = Float(Constants.fovy.radians)
        topDownOrthoHalfExtent = max(0.001, heightAboveCut * tan(fovy * 0.5))
    }

    /// Zoom in stops at the cut plane; zoom out stops at nav `topdown_ortho_zoom_out`.
    private func clampTopDownZoomToLimits() {
        // Max zoom in = the cut itself (never go below / through the roof slice).
        var height = max(topDownCutHeight + 0.001, heightAlongUp(cameraPosition))

        // Max zoom out = authored farthest view width from SampleApp.
        if let zout = savedTopDownOrthoZoomOut, zout > 0 {
            let maxHeight = topDownCutHeight + topDownHoverDistance(for: zout)
            height = min(height, maxHeight)
        }

        setHeightAlongUp(height)
        refreshTopDownOrthoFromCamera()
    }

    private func modelClipPlane(cutHeight: Float) -> SIMD4<Float> {
        let cal = usesCustomOrientation
            ? matrix_identity_float4x4
            : matrix4x4_rotation(radians: .pi, axis: SIMD3<Float>(0, 0, 1))
        let up4 = SIMD4<Float>(navigationUp.x, navigationUp.y, navigationUp.z, 0)
        let n = simd_normalize((cal.transpose * up4).xyz)
        return SIMD4(n.x, n.y, n.z, -cutHeight)
    }

    private func syncTopDownClipPlane() {
        guard let splat = modelRenderer as? SplatRenderer else { return }
        if isTopDownActive {
            splat.modelClipPlane = modelClipPlane(cutHeight: topDownCutHeight)
        } else {
            splat.modelClipPlane = nil
        }
    }

    func clearPhotoSearch() {
        photoSearchTask?.cancel()
        photoSearchTask = nil
        searchedPhotos = []
        isPhotoSearching = false
        isFetchingMorePhotos = false
        hasMorePhotos = false
        photoSearchMaxResults = PhotoSearchAPI.defaultMaxResults
        lastPhotoSearchCamera = nil
        lastPhotoSearchViewDirection = nil
        if pointClickMode {
            pointClickStatus = lastPickedCoordinate.map {
                String(format: "X: %.3f   Y: %.3f   Z: %.3f", $0.x, $0.y, $0.z)
            } ?? "Click a surface to find photos"
        }
        onPointClickStateChanged?()
    }

    /// PlayCanvas Fetch More: request a larger `max_results` page for the last click.
    func fetchMorePhotos() {
        guard pointClickMode,
              let apiBaseURL = photoAPIBaseURL,
              let world = lastPickedCoordinate,
              hasMorePhotos,
              !isPhotoSearching,
              !isFetchingMorePhotos else { return }

        photoSearchMaxResults += PhotoSearchAPI.defaultMaxResults
        isFetchingMorePhotos = true
        onPointClickStateChanged?()
        runPhotoSearch(
            apiBaseURL: apiBaseURL,
            world: world,
            camera: lastPhotoSearchCamera ?? cameraPosition,
            maxResults: photoSearchMaxResults,
            isFetchMore: true
        )
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
        guard recordedStairPoints.count >= 3 else { return }
        loadedStairPolygons.append(recordedStairPoints)
        rebuildStairRegions()
        applyStairOrGroundHeight()
    }

    /// Pick the rendered surface under a click and search nearby source photos.
    func handlePointClick(at viewPoint: CGPoint) {
        guard pointClickMode else { return }
        guard let apiBaseURL = photoAPIBaseURL else {
            pointClickStatus = "This project has no photo search API"
            onPointClickStateChanged?()
            return
        }

        guard let modelPoint = worldPosition(at: viewPoint) else {
            lastPickedCoordinate = nil
            lastPickedModelCoordinate = nil
            searchedPhotos = []
            isPhotoSearching = false
            isFetchingMorePhotos = false
            hasMorePhotos = false
            pointClickStatus = "No surface at click"
            onPointClickStateChanged?()
            return
        }

        let world = usesCustomOrientation ? modelPoint : SplatNavigationSpace.fromModel(modelPoint)
        lastPickedModelCoordinate = modelPoint
        lastPickedCoordinate = world
        // Windows: brief screen flash at click, then a reprojected world pin.
        photoClickFlashViewPoint = viewPointInSwiftUISpace(viewPoint)
        photoClickFlashUntil = CACurrentMediaTime() + MeasureConstants.photoFlashDuration
        pointClickStatus = String(format: "X: %.3f   Y: %.3f   Z: %.3f · searching…", world.x, world.y, world.z)
        searchedPhotos = []
        isPhotoSearching = true
        isFetchingMorePhotos = false
        hasMorePhotos = false
        photoSearchMaxResults = PhotoSearchAPI.defaultMaxResults
        refreshMeasureScreenChrome()
        onPointClickStateChanged?()

        let camera = cameraPosition
        // PlayCanvas: view direction is computed in the same frame as the sent
        // point inside PhotoSearchClient (normalize(sendPoint − camera)).
        lastPhotoSearchCamera = camera
        lastPhotoSearchViewDirection = {
            let toClick = world - camera
            let len = simd_length(toClick)
            guard len > 1e-6 else { return nil }
            return toClick / len
        }()

        runPhotoSearch(
            apiBaseURL: apiBaseURL,
            world: world,
            camera: camera,
            maxResults: photoSearchMaxResults,
            isFetchMore: false
        )
    }

    private func runPhotoSearch(
        apiBaseURL: URL,
        world: SIMD3<Float>,
        camera: SIMD3<Float>,
        maxResults: Int,
        isFetchMore: Bool
    ) {
        photoSearchTask?.cancel()
        let useSPZ = photoSearchUsesSPZCoordinates
        let useCalibration = photoSearchUsesServerCalibration
        photoSearchTask = Task { [photoSearchClient] in
            do {
                let response = try await photoSearchClient.search(
                    baseURL: apiBaseURL,
                    displayWorldPoint: world,
                    cameraPosition: camera,
                    maxResults: maxResults,
                    useSPZCoordinates: useSPZ,
                    useServerCalibration: useCalibration
                )
                guard !Task.isCancelled else { return }
                await MainActor.run {
                    self.searchedPhotos = response.photos
                    self.hasMorePhotos = response.hasMore
                    self.isPhotoSearching = false
                    self.isFetchingMorePhotos = false
                    self.pointClickStatus = String(
                        format: "X: %.3f   Y: %.3f   Z: %.3f · %d photos",
                        world.x, world.y, world.z, response.photos.count
                    )
                    self.onPointClickStateChanged?()
                }
            } catch {
                guard !Task.isCancelled else { return }
                await MainActor.run {
                    if isFetchMore {
                        self.photoSearchMaxResults = max(
                            PhotoSearchAPI.defaultMaxResults,
                            self.photoSearchMaxResults - PhotoSearchAPI.defaultMaxResults
                        )
                        self.isFetchingMorePhotos = false
                        self.pointClickStatus = String(
                            format: "X: %.3f   Y: %.3f   Z: %.3f · fetch more failed: %@",
                            world.x, world.y, world.z, error.localizedDescription
                        )
                    } else {
                        self.searchedPhotos = []
                        self.hasMorePhotos = false
                        self.isPhotoSearching = false
                        self.isFetchingMorePhotos = false
                        self.pointClickStatus = String(
                            format: "X: %.3f   Y: %.3f   Z: %.3f · %@",
                            world.x, world.y, world.z, error.localizedDescription
                        )
                    }
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
                                      // Match SampleApp — perspective near must be > 0.
                                      nearZ: Constants.pickNearClip,
                                      farZ: Constants.pickFarClip)
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
        let deltaTime = min(1.0 / 30.0, Float(now.timeIntervalSince(lastCameraUpdateTimestamp)))
        guard deltaTime > 0 else { return }

        if isTopDownActive {
            updateTopDownCamera(deltaTime: deltaTime)
            return
        }

        guard movement.isActive else { return }

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
            // While recording collision/stairs, allow free XZ.
            if isRecordingCollision || isRecordingStairs {
                cameraPosition = proposed
            } else {
                var clamped = proposed
                if let walkableBounds {
                    clamped = walkableBounds.clamp(clamped)
                }
                let basis = navigationBasis
                let moved = CollisionBlock.move(
                    from: basis.toLocal(cameraPosition),
                    to: basis.toLocal(clamped),
                    against: collisionBlocks
                )
                cameraPosition = basis.toWorld(moved)
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

    private func updateTopDownCamera(deltaTime: Float) {
        guard movement.isActive else { return }

        // Flat pan like walk mode: W/S forward-back on the ground plane, A/D strafe.
        // Zoom is via the magnifying-glass buttons (not W/S).
        var forward = cameraForward
        forward -= simd_dot(forward, navigationUp) * navigationUp
        var right = cameraRight
        right -= simd_dot(right, navigationUp) * navigationUp
        let forwardLength = simd_length(forward)
        let rightLength = simd_length(right)
        guard forwardLength > 1e-5, rightLength > 1e-5 else { return }
        forward /= forwardLength
        right /= rightLength

        var direction = SIMD3<Float>.zero
        if movement.forward { direction += forward }
        if movement.backward { direction -= forward }
        if movement.right { direction += right }
        if movement.left { direction -= right }

        let length = simd_length(direction)
        if length > 1e-5 {
            cameraPosition += (direction / length) * cameraMoveSpeed * deltaTime
            // Keep height within zoom limits without changing lateral pan.
            clampTopDownZoomToLimits()
        }
    }

    private func applyStairOrGroundHeight() {
        if let height = stairRegions.lazy.compactMap({ $0.navigationHeight(at: self.cameraPosition) }).first {
            persistentFloorY = height
            setHeightAlongUp(height)
        } else {
            setHeightAlongUp(persistentFloorY)
        }
    }

    // MARK: - SuperSplat `Picker.pickSurface` parity

    /// Constants from SuperSplat viewer `index.js` (Picker).
    private enum SurfacePick {
        /// `SURFACE_RADIUS_PX` — depth is taken over a disc of this radius (pick-target pixels).
        static let radiusPx = 2
        /// `SURFACE_OPACITY` — surface is where opacity in front first reaches this.
        static let opacity = 0.3
        /// `PICK_TRIALS` — independent survival trials (RGBA channels).
        static let trials = 4
    }

    /// Cached pick render, keyed like SuperSplat `cameraMatches` (view, projection, size).
    private struct PickRenderCache {
        var viewMatrix: matrix_float4x4
        var projectionMatrix: matrix_float4x4
        var width: Int
        var height: Int
        var clipKey: Float?
    }

    private func ensureStochasticPickTexture(width: Int, height: Int) -> MTLTexture? {
        guard width > 0, height > 0 else { return nil }
        if let texture = pickTexture, texture.width == width, texture.height == height {
            return texture
        }
        let desc = MTLTextureDescriptor.texture2DDescriptor(
            pixelFormat: .rgba16Float,
            width: width,
            height: height,
            mipmapped: false
        )
        desc.usage = [.renderTarget]
        desc.storageMode = .private
        guard let texture = device.makeTexture(descriptor: desc) else { return nil }
        texture.label = "Stochastic Pick"
        pickTexture = texture
        pickRenderCache = nil
        return texture
    }

    /// IEEE half → float (the pick render is RGBA16F, like SuperSplat's `half2Float`).
    private static func halfToFloat(_ h: UInt16) -> Float {
        let sign = UInt32(h & 0x8000) << 16
        let exponent = UInt32((h & 0x7c00) >> 10)
        var mantissa = UInt32(h & 0x03ff)
        var bits: UInt32
        if exponent == 0 {
            if mantissa == 0 {
                bits = sign
            } else {
                var e: UInt32 = 0
                while (mantissa & 0x0400) == 0 {
                    mantissa <<= 1
                    e += 1
                }
                mantissa &= 0x03ff
                bits = sign | ((127 - 15 + 1 - e) << 23) | (mantissa << 13)
            }
        } else if exponent == 31 {
            bits = sign | 0x7f80_0000 | (mantissa << 13)
        } else {
            bits = sign | ((exponent + 127 - 15) << 23) | (mantissa << 13)
        }
        return Float(bitPattern: bits)
    }

    /// Exact port of SuperSplat `Picker.pickSurface` position (disc search + opacity-quantile depth +
    /// unproject through the click pixel). `viewPoint` is in MTKView coordinates.
    ///
    /// Windows `pickWorldPoint` stores this point and reprojects it every frame; so does Mac.
    private func worldPosition(at viewPoint: CGPoint) -> SIMD3<Float>? {
        guard drawableSize.width > 0, drawableSize.height > 0 else { return nil }
        let bounds = metalKitView.bounds.size
        guard bounds.width > 0, bounds.height > 0 else { return nil }
        guard let splatRenderer = modelRenderer as? SplatRenderer else { return nil }

        // `pickTargetSize`: one pick pixel per CSS (point) pixel, never more than the backbuffer.
        let width = max(1, min(Int(drawableSize.width.rounded(.down)), Int(bounds.width.rounded())))
        let height = max(1, min(Int(drawableSize.height.rounded(.down)), Int(bounds.height.rounded())))

        // Normalised click, top-left origin (Windows nx / ny).
        let nx = Double(viewPoint.x / bounds.width)
#if os(macOS)
        let ny = Double(1 - viewPoint.y / bounds.height)
#else
        let ny = Double(viewPoint.y / bounds.height)
#endif
        guard nx >= 0, nx <= 1, ny >= 0, ny <= 1 else { return nil }
        // `clampPixel`
        let screenX = min(width - 1, max(0, Int((nx * Double(width)).rounded(.down))))
        let screenY = min(height - 1, max(0, Int((ny * Double(height)).rounded(.down))))

        let proj = projectionMatrix
        let view = viewMatrix
        let near = Constants.pickNearClip
        let far = Constants.pickFarClip

        guard let texture = ensureStochasticPickTexture(width: width, height: height) else { return nil }

        let clipKey: Float? = isTopDownActive ? topDownCutHeight : nil
        let cacheHit: Bool = {
            guard let cache = pickRenderCache, proceduralSplatController == nil else { return false }
            return cache.width == width && cache.height == height
                && cache.clipKey == clipKey
                && simd_equal(cache.viewMatrix, view)
                && simd_equal(cache.projectionMatrix, proj)
        }()

        if !cacheHit {
            pickRenderCache = nil
            let pickViewport = SplatRenderer.ViewportDescriptor(
                viewport: MTLViewport(originX: 0, originY: 0,
                                      width: Double(width), height: Double(height),
                                      znear: 0, zfar: 1),
                projectionMatrix: proj,
                viewMatrix: view,
                screenSize: SIMD2(width, height)
            )
            guard let pickBuffer = commandQueue.makeCommandBuffer() else { return nil }
            do {
                let ok = try splatRenderer.renderStochasticPick(
                    viewports: [pickViewport],
                    colorTexture: texture,
                    nearClip: near,
                    farClip: far,
                    to: pickBuffer
                )
                guard ok else { return nil }
            } catch {
                Self.log.error("Stochastic pick render failed: \(error.localizedDescription)")
                return nil
            }
            pickBuffer.commit()
            pickBuffer.waitUntilCompleted()
            pickRenderCache = PickRenderCache(
                viewMatrix: view,
                projectionMatrix: proj,
                width: width,
                height: height,
                clipKey: clipKey
            )
        }

        // `readAround(screenX, screenY, SURFACE_RADIUS_PX)` clamped to the render.
        let margin = SurfacePick.radiusPx
        let blockX = max(0, screenX - margin)
        let blockY = max(0, screenY - margin)
        let blockW = min(width - 1, screenX + margin) - blockX + 1
        let blockH = min(height - 1, screenY + margin) - blockY + 1
        guard blockW > 0, blockH > 0 else { return nil }

        let bytesPerPixel = 8 // RGBA16F
        let bytesPerRow = blockW * bytesPerPixel
        guard let sampleBuffer = device.makeBuffer(length: bytesPerRow * blockH, options: .storageModeShared),
              let commandBuffer = commandQueue.makeCommandBuffer(),
              let blit = commandBuffer.makeBlitCommandEncoder() else {
            return nil
        }
        blit.copy(
            from: texture,
            sourceSlice: 0,
            sourceLevel: 0,
            sourceOrigin: MTLOrigin(x: blockX, y: blockY, z: 0),
            sourceSize: MTLSize(width: blockW, height: blockH, depth: 1),
            to: sampleBuffer,
            destinationOffset: 0,
            destinationBytesPerRow: bytesPerRow,
            destinationBytesPerImage: bytesPerRow * blockH
        )
        blit.endEncoding()
        commandBuffer.commit()
        commandBuffer.waitUntilCompleted()

        let halves = sampleBuffer.contents().bindMemory(to: UInt16.self, capacity: blockW * blockH * 4)
        func depthAt(_ x: Int, _ y: Int, _ trial: Int) -> Float? {
            let localX = x - blockX
            let localY = y - blockY
            guard localX >= 0, localX < blockW, localY >= 0, localY < blockH else { return nil }
            return Self.halfToFloat(halves[(localY * blockW + localX) * 4 + trial])
        }

        // `surfaceDepth`: SURFACE_OPACITY quantile of the nearest survivors over a disc.
        var samples: [Float] = []
        samples.reserveCapacity(13 * SurfacePick.trials)
        let r = SurfacePick.radiusPx
        for dy in -r...r {
            for dx in -r...r {
                if dx * dx + dy * dy > r * r { continue }
                for trial in 0..<SurfacePick.trials {
                    if let depth = depthAt(screenX + dx, screenY + dy, trial) {
                        samples.append(depth)
                    }
                }
            }
        }
        guard !samples.isEmpty else { return nil }
        samples.sort()
        // SuperSplat: `samples[Math.max(0, Math.ceil(n * SURFACE_OPACITY) - 1)]`
        let index = max(0, Int((Double(samples.count) * SurfacePick.opacity).rounded(.up)) - 1)
        let normalizedDepth = samples[index]
        guard normalizedDepth.isFinite, normalizedDepth < 1, normalizedDepth >= 0 else { return nil }

        // Exact SuperSplat `getWorldPoint` (perspective), Metal NDC z in [0,1] (WebGL uses *2-1).
        let ndcZ = (far * normalizedDepth) / (normalizedDepth * (far - near) + near)
        guard ndcZ.isFinite, ndcZ >= 0, ndcZ <= 1 else { return nil }
        let clip = SIMD4<Float>(
            Float(screenX) / Float(width) * 2 - 1,
            (1 - Float(screenY) / Float(height)) * 2 - 1,
            ndcZ,
            1
        )
        let invViewProj = (proj * view).inverse
        let worldH = invViewProj * clip
        guard worldH.w.isFinite, abs(worldH.w) > 1e-8 else { return nil }
        let point = worldH.xyz / worldH.w
        guard point.x.isFinite, point.y.isFinite, point.z.isFinite else { return nil }
        return point
    }

    // MARK: - World-space measure chrome (same 3D points as Windows; drawn in-frame like the splat)

    private enum MeasureDraw {
        static let pinSizePerMeter: Float = 0.012
        static let pinSizeMin: Float = 0.02
        static let pinSizeMax: Float = 0.5
        static let laserThickness: Float = 0.015
        static let reticleScale = SIMD3<Float>(0.06, 0.09, 0.06)
        /// Windows pin cyan rgb(40,220,255)
        static let pinColor = SIMD4<Float>(40 / 255, 220 / 255, 1, 0.95)
        static let laserColor = SIMD4<Float>(50 / 255, 230 / 255, 1, 0.95)
        static let previewLaserColor = SIMD4<Float>(50 / 255, 230 / 255, 1, 0.4)
        static let hoverColor = SIMD4<Float>(40 / 255, 220 / 255, 1, 0.95)
        static let deleteHoverColor = SIMD4<Float>(1, 90 / 255, 90 / 255, 0.95)
    }

    private func drawMeasureOverlay(
        viewProjection: matrix_float4x4,
        colorTexture: MTLTexture,
        depthTexture: MTLTexture?,
        commandBuffer: MTLCommandBuffer
    ) {
        guard let overlay = measureOverlayRenderer else { return }
        let scale = measureOverlayScale
        let eyeModel = (lastViewMatrix.inverse * SIMD4<Float>(0, 0, 0, 1)).xyz

        if measureMode || !measureNodes.isEmpty {
            for (index, node) in measureNodes.enumerated() {
                let pin = node.modelPosition
                let distance = max(0.35, simd_length(pin - eyeModel))
                let size = min(
                    MeasureDraw.pinSizeMax * scale,
                    max(MeasureDraw.pinSizeMin * scale, distance * MeasureDraw.pinSizePerMeter * scale)
                )
                let highlighted = measureMode && measureDeleteMode && measureDeleteHoverIndex == index
                overlay.drawPins(
                    atModelPositions: [pin],
                    diameter: size,
                    color: highlighted ? MeasureDraw.deleteHoverColor : MeasureDraw.pinColor,
                    viewProjection: viewProjection,
                    colorTexture: colorTexture,
                    depthTexture: depthTexture,
                    to: commandBuffer
                )
            }

            var segments: [(SIMD3<Float>, SIMD3<Float>)] = []
            if measureNodes.count >= 2 {
                for i in 1..<measureNodes.count {
                    let node = measureNodes[i]
                    guard !node.isStartOfChain else { continue }
                    segments.append((measureNodes[i - 1].modelPosition, node.modelPosition))
                }
            }
            if !segments.isEmpty {
                overlay.drawSegments(
                    segments: segments,
                    thickness: MeasureDraw.laserThickness * scale,
                    color: MeasureDraw.laserColor,
                    viewProjection: viewProjection,
                    colorTexture: colorTexture,
                    depthTexture: depthTexture,
                    to: commandBuffer
                )
            }
        }

        // Hover pointer is SwiftUI dual-ring (Windows mediaServer), not the Metal cone.

        if pointClickMode, let marker = lastPickedModelCoordinate {
            let distance = max(0.35, simd_length(marker - eyeModel))
            let size = min(
                MeasureDraw.pinSizeMax * scale,
                max(MeasureDraw.pinSizeMin * scale, distance * MeasureDraw.pinSizePerMeter * scale)
            )
            overlay.drawPins(
                atModelPositions: [marker],
                diameter: size,
                color: SIMD4<Float>(47 / 255, 123 / 255, 1, 0.95),
                viewProjection: viewProjection,
                colorTexture: colorTexture,
                depthTexture: depthTexture,
                to: commandBuffer
            )
        }
    }

    func draw(in view: MTKView) {
        guard let modelRenderer, modelRenderer.isReadyToRender else {
            return
        }
        guard let drawable = view.currentDrawable else {
            // Don't fail immediately — drawable can be nil for a frame. Timeout handles stuck captures.
            return
        }

        _ = inFlightSemaphore.wait(timeout: DispatchTime.distantFuture)

        guard let commandBuffer = commandQueue.makeCommandBuffer() else {
            inFlightSemaphore.signal()
            screenshotWaiter.finish(nil)
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

        // Re-pick under the stored cursor while walking (Windows hover throttle).
        if measureMode, let hoverPoint = lastMeasureHoverViewPoint {
            pickMeasureHover(at: hoverPoint, force: false)
        }

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
            let colorTexture = view.multisampleColorTexture ?? drawable.texture
            let viewProjection = lastProjectionMatrix * lastViewMatrix
            // Draw pins/lasers in the same Metal frame as the splat (Windows stickiness).
            // 3D points come from SuperSplat pickSurface-equivalent; distances match Windows.
            if measureMode || !measureNodes.isEmpty || (pointClickMode && lastPickedModelCoordinate != nil) {
                drawMeasureOverlay(
                    viewProjection: viewProjection,
                    colorTexture: colorTexture,
                    depthTexture: view.depthStencilTexture,
                    commandBuffer: commandBuffer
                )
            }

            // Labels + Windows cursor ring in SwiftUI; pins stay Metal.
            let previousLabels = measureLabelOverlays
            let previousHover = measureHoverOverlay
            let previousLasers = measureLaserOverlays
            refreshMeasureScreenChrome()
            if previousLabels != measureLabelOverlays
                || previousHover != measureHoverOverlay
                || previousLasers != measureLaserOverlays {
                onMeasureStateChanged?()
            }

            if screenshotWaiter.hasPending {
                enqueueScreenshotReadback(
                    from: drawable.texture,
                    commandBuffer: commandBuffer
                )
            }
            commandBuffer.present(drawable)
        } else {
            screenshotWaiter.finish(nil)
        }

        commandBuffer.commit()
    }

    private func enqueueScreenshotReadback(
        from texture: MTLTexture,
        commandBuffer: MTLCommandBuffer
    ) {
        let width = texture.width
        let height = texture.height
        guard width > 0, height > 0 else {
            screenshotWaiter.finish(nil)
            return
        }

        let bytesPerPixel = 4
        let alignment = max(device.minimumLinearTextureAlignment(for: texture.pixelFormat), bytesPerPixel)
        let bytesPerRow = ((width * bytesPerPixel + alignment - 1) / alignment) * alignment
        let byteCount = bytesPerRow * height

        guard !texture.isFramebufferOnly else {
            Self.log.error("Screenshot source is framebufferOnly; set MTKView.framebufferOnly = false")
            screenshotWaiter.finish(nil)
            return
        }

        guard let buffer = device.makeBuffer(length: byteCount, options: .storageModeShared),
              let blit = commandBuffer.makeBlitCommandEncoder() else {
            screenshotWaiter.finish(nil)
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

        commandBuffer.addCompletedHandler { [weak self] _ in
            let bgraData = Data(bytes: buffer.contents(), count: byteCount)
            DispatchQueue.main.async {
                let image = PlatformImage.fromBGRA(
                    bgraData: bgraData,
                    width: width,
                    height: height,
                    bytesPerRow: bytesPerRow
                )
                self?.screenshotWaiter.finish(image)
            }
        }
    }

    func mtkView(_ view: MTKView, drawableSizeWillChange size: CGSize) {
        drawableSize = size
    }
}

#endif // os(iOS) || os(macOS) || os(visionOS)
