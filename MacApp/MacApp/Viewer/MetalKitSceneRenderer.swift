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

    // MARK: - Measure (PlayCanvas SplatMeasurer: pick pass + hover reticle)
    var measureMode = false
    /// Measure pin snapping is disabled.
    private(set) var measureSnappingEnabled = false
    var measureDeleteMode = false
    var measureStatus: String = "Measure off"
    /// Screen-space distance labels for SwiftUI overlay.
    private(set) var measureLabelOverlays: [MeasureLabelOverlay] = []
    private var measureNodes: [MeasureNode] = []
    private var measureHoverModelPoint: SIMD3<Float>?
    private var measureDeleteHoverIndex: Int?
    /// Last cursor in view coords (PlayCanvas keeps mouseX/Y and re-picks every tick).
    private var lastMeasureHoverViewPoint: CGPoint?
    private var lastMeasureHoverPickTime: CFTimeInterval = 0
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
        /// Model / depth-unprojection space (for Metal draw).
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

    private enum MeasureConstants {
        static let snapRadius: Float = 0.25
        static let laserThickness: Float = 0.015
        static let pointLimit = 10
        static let peripheralAngleDegrees: Float = 60
        /// PlayCanvas reticleScaleOffset default (cone).
        static let reticleScale = SIMD3<Float>(0.06, 0.09, 0.06)
        static let pinSizePerMeter: Float = 0.012
        static let pinSizeMin: Float = 0.02
        static let pinSizeMax: Float = 0.5
        static let pulseSpeed: Float = 3.5
        static let pulseMin: Float = 0.75
        static let pulseMax: Float = 1.25
        /// Hover pick throttle (~50 Hz), same as PlayCanvas.
        static let hoverPickInterval: CFTimeInterval = 0.02
        static let pinColor = SIMD4<Float>(0.18, 0.48, 1.0, 0.95)
        static let laserColor = SIMD4<Float>(0.18, 0.55, 1.0, 0.9)
        /// PlayCanvas reticle cyan.
        static let hoverColor = SIMD4<Float>(0.0, 1.0, 1.0, 0.95)
        static let deleteHoverColor = SIMD4<Float>(1.0, 0.25, 0.25, 0.95)
        static let previewLaserColor = SIMD4<Float>(0.15, 0.9, 1.0, 0.45)
        static let overlayScaleMin: Float = 0.05
        static let overlayScaleMax: Float = 2.0
        static let overlayScaleDefault: Float = 1.0
    }

    /// World-space snap / delete hit radius, scaled with nav `measure_scale`.
    private var measureSnapRadius: Float {
        MeasureConstants.snapRadius * measureOverlayScale
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
    /// PlayCanvas-style pick targets (alpha-clipped splat depth, separate from display depth).
    private var pickColorTexture: MTLTexture?
    private var pickDepthTexture: MTLTexture?
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

    /// Filled on the next rendered frame when a product-search screenshot is requested.
    private var screenshotContinuation: CheckedContinuation<PlatformImage?, Never>?

    /// Captures the next presented frame as a `PlatformImage` (BGRA framebuffer readback).
    func captureScreenshotImage() async -> PlatformImage? {
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
        pickColorTexture = nil
        pickDepthTexture = nil
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
        if pointClickMode {
            pointClickStatus = "Click a surface to find photos"
        } else {
            pointClickStatus = "Search Image off"
        }
        onPointClickStateChanged?()
        onMeasureStateChanged?()

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
        if let speed = data.moveSpeed, speed > 0 {
            cameraMoveSpeed = speed
        }
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
            pointClickStatus = "Click a surface to find photos"
        } else {
            lastPickedModelCoordinate = nil
            pointClickStatus = "Search Image off"
            photoSearchTask?.cancel()
            photoSearchTask = nil
            isPhotoSearching = false
            isFetchingMorePhotos = false
            hasMorePhotos = false
        }
        onPointClickStateChanged?()
    }

    // MARK: Measure tool

    func setMeasureMode(_ enabled: Bool) {
        if enabled {
            setPointClickMode(false)
        }
        measureMode = enabled
        measureDeleteMode = false
        measureHoverModelPoint = nil
        measureDeleteHoverIndex = nil
        lastMeasureHoverViewPoint = nil
        lastMeasureHoverPickTime = 0
        if enabled {
            measureStatus = "Measure on · click two points"
        } else {
            measureStatus = measureNodes.isEmpty ? "Measure off" : "Measure off · \(measureNodes.count) points kept"
        }
        refreshMeasureLabels()
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
        refreshMeasureLabels()
        onMeasureStateChanged?()
        return true
    }

    func clearMeasureGeometry() {
        measureNodes.removeAll(keepingCapacity: true)
        measureHoverModelPoint = nil
        measureDeleteHoverIndex = nil
        lastMeasureHoverViewPoint = nil
        measureLabelOverlays = []
    }

    /// PlayCanvas hover tracking — uses the same alpha-clipped pick pass as click.
    func updateMeasureHover(at viewPoint: CGPoint) {
        guard measureMode else { return }
        lastMeasureHoverViewPoint = viewPoint
        pickMeasureHover(at: viewPoint, force: false)
    }

    private func pickMeasureHover(at viewPoint: CGPoint, force: Bool) {
        guard measureMode else { return }
        let now = CACurrentMediaTime()
        if !force, now - lastMeasureHoverPickTime < MeasureConstants.hoverPickInterval { return }
        lastMeasureHoverPickTime = now

        guard let modelPoint = worldPosition(at: viewPoint) else {
            measureHoverModelPoint = nil
            measureDeleteHoverIndex = nil
            return
        }

        if measureDeleteMode {
            measureDeleteHoverIndex = nearestMeasureNodeIndex(to: modelPoint, radius: measureSnapRadius)
            measureHoverModelPoint = measureDeleteHoverIndex.map { measureNodes[$0].modelPosition }
            return
        }

        measureHoverModelPoint = modelPoint
        measureDeleteHoverIndex = nil
    }

    func handleMeasureClick(at viewPoint: CGPoint) {
        guard measureMode else { return }

        // Same alpha-clipped pick pass as Point Click / hover.
        guard let modelPoint = worldPosition(at: viewPoint) else {
            measureStatus = "No surface at click"
            onMeasureStateChanged?()
            return
        }

        if measureDeleteMode {
            if let index = measureDeleteHoverIndex
                ?? nearestMeasureNodeIndex(to: modelPoint, radius: measureSnapRadius) {
                deleteMeasureNode(at: index)
                measureDeleteMode = false
                measureDeleteHoverIndex = nil
                measureStatus = "Deleted pin · Measure on"
                onMeasureStateChanged?()
            } else {
                measureStatus = "No pin near click"
                onMeasureStateChanged?()
            }
            return
        }

        addMeasurePoint(modelPoint)
    }

    private func addMeasurePoint(_ modelPoint: SIMD3<Float>) {
        if measureNodes.count >= MeasureConstants.pointLimit {
            measureNodes.removeFirst()
        }

        // Fixed 2-click chains: open start → complete segment → next click starts a new chain.
        let isStart: Bool
        var distance: Float?
        if let previous = measureNodes.last,
           previous.isStartOfChain,
           canLink(toPrevious: previous.modelPosition) {
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
        refreshMeasureLabels()
        onMeasureStateChanged?()
    }

    private func deleteMeasureNode(at index: Int) {
        guard measureNodes.indices.contains(index) else { return }
        measureNodes.remove(at: index)
        rebuildMeasureChainDistances()
        refreshMeasureLabels()
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

    private func canLink(toPrevious previousModel: SIMD3<Float>) -> Bool {
        let previousWorld = usesCustomOrientation ? previousModel : SplatNavigationSpace.fromModel(previousModel)
        let toPrev = previousWorld - cameraPosition
        let len = simd_length(toPrev)
        guard len > 1e-5 else { return true }
        let dir = toPrev / len
        let cosLimit = cos(MeasureConstants.peripheralAngleDegrees * .pi / 180)
        return simd_dot(cameraForward, dir) >= cosLimit
    }

    private func nearestMeasureNodeIndex(to modelPoint: SIMD3<Float>, radius: Float) -> Int? {
        var bestIndex: Int?
        var bestDistance = radius
        for (index, node) in measureNodes.enumerated() {
            let d = simd_distance(node.modelPosition, modelPoint)
            if d <= bestDistance {
                bestDistance = d
                bestIndex = index
            }
        }
        return bestIndex
    }

    private func refreshMeasureLabels() {
        var overlays: [MeasureLabelOverlay] = []
        guard measureNodes.count >= 2 else {
            measureLabelOverlays = []
            return
        }
        for i in 1..<measureNodes.count {
            let node = measureNodes[i]
            guard !node.isStartOfChain, let distance = node.distanceToPrevious else { continue }
            let prev = measureNodes[i - 1].modelPosition
            let mid = (prev + node.modelPosition) * 0.5
            guard let screen = projectModelPointToView(mid) else { continue }
            overlays.append(MeasureLabelOverlay(
                id: i,
                viewPoint: screen,
                text: Self.formatMeasureDistance(meters: distance)
            ))
        }
        measureLabelOverlays = overlays
    }

    /// PlayCanvas `getFormattedDistance` with imperial symbols (`'` / `"`) and 1/32" fractions.
    private static func formatMeasureDistance(meters: Float) -> String {
        let totalFeet = Double(meters) * 3.280839895
        var feet = Int(floor(totalFeet))
        var inches = 0
        var fractionStr = ""

        let remainingInches = (totalFeet - Double(feet)) * 12.0
        inches = Int(floor(remainingInches))
        let fractionOfInch = remainingInches - Double(inches)

        // Round to nearest 32nd (PlayCanvas enableImperialFractions).
        var numerator = Int((fractionOfInch * 32.0).rounded())
        if numerator == 32 {
            numerator = 0
            inches += 1
        }
        if inches == 12 {
            inches = 0
            feet += 1
        }
        if numerator > 0 {
            let divisor = gcd(numerator, 32)
            fractionStr = " \(numerator / divisor)/\(32 / divisor)"
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
        guard abs(clip.w) > 1e-6 else { return nil }
        let ndc = clip.xyz / clip.w
        // Behind / far outside the clip volume — hide label.
        guard ndc.z >= -0.05, ndc.z <= 1.05 else { return nil }
        let bounds = metalKitView.bounds
        guard bounds.width > 1, bounds.height > 1 else { return nil }
        let x = CGFloat((ndc.x + 1) * 0.5) * bounds.width
        // SwiftUI `.position` uses top-left origin on every platform (not AppKit bottom-left).
        let y = CGFloat((1 - ndc.y) * 0.5) * bounds.height
        return CGPoint(x: x, y: y)
    }

    private func drawMeasureOverlay(
        viewProjection: matrix_float4x4,
        colorTexture: MTLTexture,
        depthTexture: MTLTexture?,
        commandBuffer: MTLCommandBuffer
    ) {
        guard let overlay = measureOverlayRenderer else { return }
        let scale = measureOverlayScale

        // Same distance-scaled blue dots as Point Click.
        let eyeModel = (lastViewMatrix.inverse * SIMD4<Float>(0, 0, 0, 1)).xyz
        for pin in measureNodes.map(\.modelPosition) {
            let distance = max(0.35, simd_length(pin - eyeModel))
            let size = min(
                MeasureConstants.pinSizeMax * scale,
                max(MeasureConstants.pinSizeMin * scale, distance * MeasureConstants.pinSizePerMeter * scale)
            )
            overlay.drawPins(
                atModelPositions: [pin],
                diameter: size,
                color: MeasureConstants.pinColor,
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
                thickness: MeasureConstants.laserThickness * scale,
                color: MeasureConstants.laserColor,
                viewProjection: viewProjection,
                colorTexture: colorTexture,
                depthTexture: depthTexture,
                to: commandBuffer
            )
        }

        // PlayCanvas hover cone + preview laser (pick-pass position).
        if measureMode, let hover = measureHoverModelPoint {
            let hoverColor = measureDeleteMode ? MeasureConstants.deleteHoverColor : MeasureConstants.hoverColor
            let t = Float(CACurrentMediaTime())
            let sinWave = sin(t * MeasureConstants.pulseSpeed)
            let pulse = MeasureConstants.pulseMin
                + (MeasureConstants.pulseMax - MeasureConstants.pulseMin) * (sinWave + 1) * 0.5
            overlay.drawReticle(
                atModelPosition: hover,
                scale: MeasureConstants.reticleScale * scale,
                pulse: measureDeleteMode ? 1.2 : pulse,
                color: hoverColor,
                viewProjection: viewProjection,
                colorTexture: colorTexture,
                depthTexture: depthTexture,
                to: commandBuffer
            )

            if !measureDeleteMode,
               let last = measureNodes.last,
               last.isStartOfChain,
               canLink(toPrevious: last.modelPosition) {
                overlay.drawSegments(
                    segments: [(last.modelPosition, hover)],
                    thickness: MeasureConstants.laserThickness * 0.85 * scale,
                    color: MeasureConstants.previewLaserColor,
                    viewProjection: viewProjection,
                    colorTexture: colorTexture,
                    depthTexture: depthTexture,
                    to: commandBuffer
                )
            }
        }
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
            viewDirection: lastPhotoSearchViewDirection,
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
        pointClickStatus = String(format: "X: %.3f   Y: %.3f   Z: %.3f · searching…", world.x, world.y, world.z)
        searchedPhotos = []
        isPhotoSearching = true
        isFetchingMorePhotos = false
        hasMorePhotos = false
        photoSearchMaxResults = PhotoSearchAPI.defaultMaxResults
        onPointClickStateChanged?()

        let camera = cameraPosition
        // PlayCanvas: normalize(clickedPoint − cameraPosition)
        let toClick = world - camera
        let viewDirection: SIMD3<Float>? = {
            let len = simd_length(toClick)
            guard len > 1e-6 else { return nil }
            return toClick / len
        }()
        lastPhotoSearchCamera = camera
        lastPhotoSearchViewDirection = viewDirection

        runPhotoSearch(
            apiBaseURL: apiBaseURL,
            world: world,
            camera: camera,
            viewDirection: viewDirection,
            maxResults: photoSearchMaxResults,
            isFetchMore: false
        )
    }

    private func runPhotoSearch(
        apiBaseURL: URL,
        world: SIMD3<Float>,
        camera: SIMD3<Float>,
        viewDirection: SIMD3<Float>?,
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
                    viewDirection: viewDirection,
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

    private func applyStairOrGroundHeight() {
        if let height = stairRegions.lazy.compactMap({ $0.navigationHeight(at: self.cameraPosition) }).first {
            persistentFloorY = height
            setHeightAlongUp(height)
        } else {
            setHeightAlongUp(persistentFloorY)
        }
    }

    private func ensurePickTargets(width: Int, height: Int) -> (color: MTLTexture, depth: MTLTexture)? {
        guard width > 0, height > 0 else { return nil }
        if let color = pickColorTexture, let depth = pickDepthTexture,
           color.width == width, color.height == height,
           depth.width == width, depth.height == height {
            return (color, depth)
        }

        let colorDesc = MTLTextureDescriptor.texture2DDescriptor(
            pixelFormat: .r8Unorm,
            width: width,
            height: height,
            mipmapped: false
        )
        colorDesc.usage = [.renderTarget]
        colorDesc.storageMode = .private

        let depthDesc = MTLTextureDescriptor.texture2DDescriptor(
            pixelFormat: .depth32Float,
            width: width,
            height: height,
            mipmapped: false
        )
        depthDesc.usage = [.renderTarget]
        depthDesc.storageMode = .private

        guard let color = device.makeTexture(descriptor: colorDesc),
              let depth = device.makeTexture(descriptor: depthDesc) else {
            return nil
        }
        color.label = "Pick Color"
        depth.label = "Pick Depth"
        pickColorTexture = color
        pickDepthTexture = depth
        return (color, depth)
    }

    /// Depth-unproject a view click using a PlayCanvas-style alpha-clipped pick pass
    /// (`SplatRenderer.renderPickDepth`), not the soft display depth buffer.
    private func worldPosition(at viewPoint: CGPoint) -> SIMD3<Float>? {
        guard drawableSize.width > 0, drawableSize.height > 0 else { return nil }
        guard metalKitView.bounds.width > 0, metalKitView.bounds.height > 0 else { return nil }
        guard let splatRenderer = modelRenderer as? SplatRenderer else { return nil }

        let width = Int(drawableSize.width.rounded())
        let height = Int(drawableSize.height.rounded())
        guard let targets = ensurePickTargets(width: width, height: height) else { return nil }

        let mtlViewport = MTLViewport(
            originX: 0, originY: 0,
            width: Double(width), height: Double(height),
            znear: 0, zfar: 1
        )
        let pickViewport = SplatRenderer.ViewportDescriptor(
            viewport: mtlViewport,
            projectionMatrix: lastProjectionMatrix,
            viewMatrix: lastViewMatrix,
            screenSize: SIMD2(width, height)
        )

        guard let pickBuffer = commandQueue.makeCommandBuffer() else { return nil }
        do {
            let ok = try splatRenderer.renderPickDepth(
                viewports: [pickViewport],
                colorTexture: targets.color,
                depthTexture: targets.depth,
                to: pickBuffer
            )
            guard ok else { return nil }
        } catch {
            Self.log.error("Pick depth render failed: \(error.localizedDescription)")
            return nil
        }
        pickBuffer.commit()
        pickBuffer.waitUntilCompleted()

        let scaleX = drawableSize.width / metalKitView.bounds.width
        let scaleY = drawableSize.height / metalKitView.bounds.height

#if os(macOS)
        let pixelX = Int((viewPoint.x * scaleX).rounded(.down))
        let pixelY = Int(((metalKitView.bounds.height - viewPoint.y) * scaleY).rounded(.down))
#else
        let pixelX = Int((viewPoint.x * scaleX).rounded(.down))
        let pixelY = Int((viewPoint.y * scaleY).rounded(.down))
#endif

        let depthTexture = targets.depth
        let maxX = max(depthTexture.width - 1, 0)
        let maxY = max(depthTexture.height - 1, 0)
        guard pixelX >= 0, pixelY >= 0, pixelX <= maxX, pixelY <= maxY else { return nil }

        // Search a small screen-space neighborhood; prefer the click pixel, else nearest hit.
        let radius = 12
        let x0 = max(pixelX - radius, 0)
        let y0 = max(pixelY - radius, 0)
        let x1 = min(pixelX + radius, maxX)
        let y1 = min(pixelY + radius, maxY)
        let regionW = x1 - x0 + 1
        let regionH = y1 - y0 + 1
        let sampleCount = regionW * regionH
        let bytesPerSample = MemoryLayout<Float>.size
        let bytesPerRow = bytesPerSample * regionW
        guard let sampleBuffer = device.makeBuffer(
            length: bytesPerRow * regionH,
            options: .storageModeShared
        ) else {
            return nil
        }

        guard let commandBuffer = commandQueue.makeCommandBuffer(),
              let blit = commandBuffer.makeBlitCommandEncoder() else {
            return nil
        }
        blit.copy(
            from: depthTexture,
            sourceSlice: 0,
            sourceLevel: 0,
            sourceOrigin: MTLOrigin(x: x0, y: y0, z: 0),
            sourceSize: MTLSize(width: regionW, height: regionH, depth: 1),
            to: sampleBuffer,
            destinationOffset: 0,
            destinationBytesPerRow: bytesPerRow,
            destinationBytesPerImage: bytesPerRow * regionH
        )
        blit.endEncoding()
        commandBuffer.commit()
        commandBuffer.waitUntilCompleted()

        let depths = sampleBuffer.contents().bindMemory(to: Float.self, capacity: sampleCount)
        // Prefer closest screen-space hit; ties break toward nearer camera depth.
        var bestX = pixelX
        var bestY = pixelY
        var bestScreenDist2 = Int.max
        var bestDepth: Float = .greatestFiniteMagnitude
        var found = false
        for row in 0..<regionH {
            for col in 0..<regionW {
                let d = depths[row * regionW + col]
                guard d.isFinite, d > 1e-5, d < 1.0 - 1e-5 else { continue }
                let sx = x0 + col
                let sy = y0 + row
                let dx = sx - pixelX
                let dy = sy - pixelY
                let screenDist2 = dx * dx + dy * dy
                if screenDist2 < bestScreenDist2
                    || (screenDist2 == bestScreenDist2 && d < bestDepth) {
                    bestScreenDist2 = screenDist2
                    bestDepth = d
                    bestX = sx
                    bestY = sy
                    found = true
                }
            }
        }
        guard found else { return nil }

        let ndcX = (2.0 * Float(bestX) + 1.0) / Float(width) - 1.0
        let ndcY = 1.0 - (2.0 * Float(bestY) + 1.0) / Float(height)
        let clip = SIMD4<Float>(ndcX, ndcY, bestDepth, 1)
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

        // Re-pick under the stored cursor so the cone tracks while walking
        // (PlayCanvas updateTrackingPreviews ~50 Hz with mouseX/Y).
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
            // Keep pins/lasers after exiting measure mode (PlayCanvas persistInNormalMode).
            if !measureNodes.isEmpty || measureMode {
                drawMeasureOverlay(
                    viewProjection: viewProjection,
                    colorTexture: colorTexture,
                    depthTexture: view.depthStencilTexture,
                    commandBuffer: commandBuffer
                )
                let previousOverlays = measureLabelOverlays
                refreshMeasureLabels()
                // Only push SwiftUI when label screen positions/text actually change.
                if previousOverlays != measureLabelOverlays {
                    onMeasureStateChanged?()
                }
            }

            // SampleApp / PlayCanvas SplatClickQuery blue pick marker.
            if let marker = lastPickedModelCoordinate, pointClickMode {
                let distance: Float
                if let nav = lastPickedCoordinate {
                    distance = max(0.35, simd_length(nav - cameraPosition))
                } else {
                    distance = 2.0
                }
                let scale = measureOverlayScale
                // PlayCanvas: clamp(distance * 0.012, 0.02, 0.5) × measure_scale from nav.txt
                let size = min(0.5 * scale, max(0.02 * scale, distance * 0.012 * scale))
                measureOverlayRenderer?.drawPins(
                    atModelPositions: [marker],
                    diameter: size,
                    color: SIMD4<Float>(0.18, 0.48, 1.0, 0.95),
                    viewProjection: viewProjection,
                    colorTexture: colorTexture,
                    depthTexture: view.depthStencilTexture,
                    to: commandBuffer
                )
            }

            if let continuation = screenshotContinuation {
                screenshotContinuation = nil
                enqueueScreenshotReadback(
                    from: colorTexture,
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
        continuation: CheckedContinuation<PlatformImage?, Never>
    ) {
        let width = texture.width
        let height = texture.height
        guard width > 0, height > 0 else {
            continuation.resume(returning: nil)
            return
        }

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
            let image = PlatformImage.fromBGRA(
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

    func mtkView(_ view: MTKView, drawableSizeWillChange size: CGSize) {
        drawableSize = size
    }
}

#endif // os(iOS) || os(macOS) || os(visionOS)
