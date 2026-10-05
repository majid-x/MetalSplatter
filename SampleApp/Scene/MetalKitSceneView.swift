#if os(iOS) || os(macOS)

import SwiftUI
import MetalKit
import UniformTypeIdentifiers
import Darwin

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
    @State private var measureMode = false
    @State private var measureStatus = "Measure off"
    @State private var measureLabelOverlays: [MetalKitSceneRenderer.MeasureLabelOverlay] = []
    @State private var measureCalibrationFactor: Float = 1.0
    @State private var lastRawSegmentMeters: Float?
    @State private var actualLengthCmText = ""
    @State private var searchedPhotos: [PhotoSearchResult] = []
    @State private var isPhotoSearching = false
    @State private var hasMorePhotos = false
    @State private var isFetchingMorePhotos = false
    @State private var photoSearchUsesSPZCoordinates = false
    @State private var photoAPIURLText = UserDefaults.standard.string(forKey: "SampleApp.photoAPIBaseURL")
        ?? PhotoSearchAPI.baseURL.absoluteString
    @State private var showPhotoPanel = false
    @State private var isPlacingCollisionBlocks = false
    @State private var isSelectingCollisionBlocks = false
    @State private var isRecordingCollision = false
    @State private var isRecordingClickCollision = false
#if os(iOS)
    @State private var exportDocument = CollisionPathDocument(text: "")
    @State private var isExportingNavigation = false
#endif
    @State private var isRecordingStairs = false
    @State private var isSettingCameraAngles = false
    @State private var isSettingStartPoint = false
    @State private var topDownPhase: MetalKitSceneRenderer.TopDownPhase = .off
    @State private var topDownStatus = "Top Down off"
    @State private var topDownOrthoSlider: Double = 10
    /// Class flag so slider sync is visible to onChange even across SwiftUI state coalescing.
    @State private var topDownSliderSync = TopDownSliderSyncGate()
    @State private var showMoveSpeedControls = false
    @State private var moveSpeedSlider: Double = Double(Constants.cameraMoveSpeed)
    @State private var showMeasureSizeControls = false
    @State private var measureSizeSlider: Double = 1.0
    @State private var heightNudgeSensitivity: Double = 0.05
    @State private var cameraRotateSensitivity: Double = 90
    @State private var blockSize: Double = Double(Constants.collisionBlockWidth)

    private var isTopDownMode: Bool { topDownPhase != .off }

    private var isCollisionModeActive: Bool {
        isPlacingCollisionBlocks
            || isSelectingCollisionBlocks
            || isRecordingCollision
            || isRecordingClickCollision
    }

    var body: some View {
        HStack(spacing: 0) {
            ZStack {
                MetalKitSceneRepresentable(
                    modelIdentifier: modelIdentifier,
                    rendererBox: rendererBox,
                    onPointClickStateChanged: {
                        pointClickMode = rendererBox.renderer?.pointClickMode ?? false
                        pointClickStatus = rendererBox.renderer?.pointClickStatus ?? "Point Click off"
                        searchedPhotos = rendererBox.renderer?.searchedPhotos ?? []
                        isPhotoSearching = rendererBox.renderer?.isPhotoSearching ?? false
                        hasMorePhotos = rendererBox.renderer?.hasMorePhotos ?? false
                        isFetchingMorePhotos = rendererBox.renderer?.isFetchingMorePhotos ?? false
                        photoSearchUsesSPZCoordinates = rendererBox.renderer?.photoSearchUsesSPZCoordinates ?? false
                        if isPhotoSearching || !searchedPhotos.isEmpty {
                            showPhotoPanel = true
                        }
                    },
                    onMeasureStateChanged: {
                        measureMode = rendererBox.renderer?.measureMode ?? false
                        measureStatus = rendererBox.renderer?.measureStatus ?? "Measure off"
                        measureLabelOverlays = rendererBox.renderer?.measureLabelOverlays ?? []
                        measureCalibrationFactor = rendererBox.renderer?.measureCalibrationFactor ?? 1.0
                        lastRawSegmentMeters = rendererBox.renderer?.lastRawSegmentMeters
                    },
                    onTopDownStateChanged: {
                        topDownPhase = rendererBox.renderer?.topDownPhase ?? .off
                        topDownStatus = rendererBox.renderer?.topDownStatus ?? "Top Down off"
                        if let ortho = rendererBox.renderer?.topDownOrthoHalfExtent {
                            topDownSliderSync.isSyncing = true
                            topDownOrthoSlider = Double(ortho)
                            DispatchQueue.main.async {
                                topDownSliderSync.isSyncing = false
                            }
                        }
                    }
                )
                .frame(maxWidth: .infinity, maxHeight: .infinity)

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

                VStack(alignment: .leading, spacing: 0) {
                    HStack(alignment: .top, spacing: 12) {
                        VStack(alignment: .leading, spacing: 8) {
                            Button(pointClickMode ? "Point Click: On" : "Point Click") {
                                let enabled = !pointClickMode
#if os(macOS)
                                rendererBox.cameraView?.setMouseLookActive(false)
#endif
                                if enabled {
                                    measureMode = false
                                    isPlacingCollisionBlocks = false
                                    isSelectingCollisionBlocks = false
                                    isRecordingCollision = false
                                    isRecordingStairs = false
                                    isRecordingClickCollision = false
                                    isSettingCameraAngles = false
                                    isSettingStartPoint = false
                                    showMoveSpeedControls = false
                                    showMeasureSizeControls = false
                                    if isTopDownMode {
                                        rendererBox.renderer?.setTopDownMode(false)
                                        topDownPhase = .off
                                        topDownStatus = "Top Down off"
                                    }
                                    applyPhotoAPIURLFromField()
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
                            .buttonStyle(.borderedProminent)
                            .tint(pointClickMode ? .orange : .accentColor)

                            Button(measureMode ? "Measure: On" : "Measure / Calibrate") {
                                let enabled = !measureMode
#if os(macOS)
                                rendererBox.cameraView?.setMouseLookActive(false)
#endif
                                if enabled {
                                    pointClickMode = false
                                    showPhotoPanel = false
                                    isPlacingCollisionBlocks = false
                                    isSelectingCollisionBlocks = false
                                    isRecordingCollision = false
                                    isRecordingStairs = false
                                    isRecordingClickCollision = false
                                    isSettingCameraAngles = false
                                    isSettingStartPoint = false
                                    showMoveSpeedControls = false
                                    showMeasureSizeControls = false
                                    if isTopDownMode {
                                        rendererBox.renderer?.setTopDownMode(false)
                                        topDownPhase = .off
                                        topDownStatus = "Top Down off"
                                    }
                                }
                                rendererBox.renderer?.setMeasureMode(enabled)
                                measureMode = enabled
                                measureStatus = rendererBox.renderer?.measureStatus ?? measureStatus
                                measureLabelOverlays = rendererBox.renderer?.measureLabelOverlays ?? []
                                measureCalibrationFactor = rendererBox.renderer?.measureCalibrationFactor ?? 1.0
                                lastRawSegmentMeters = rendererBox.renderer?.lastRawSegmentMeters
                            }
                            .buttonStyle(.borderedProminent)
                            .tint(measureMode ? Color(red: 0.2, green: 0.85, blue: 0.95) : .accentColor)

                            Button(isTopDownMode ? "Top Down: On" : "Top Down View") {
                                let enabled = !isTopDownMode
#if os(macOS)
                                rendererBox.cameraView?.setMouseLookActive(false)
#endif
                                if enabled {
                                    pointClickMode = false
                                    showPhotoPanel = false
                                    measureMode = false
                                    isPlacingCollisionBlocks = false
                                    isSelectingCollisionBlocks = false
                                    isRecordingCollision = false
                                    isRecordingStairs = false
                                    isRecordingClickCollision = false
                                    isSettingCameraAngles = false
                                    isSettingStartPoint = false
                                    showMoveSpeedControls = false
                                    showMeasureSizeControls = false
                                    rendererBox.renderer?.setMeasureMode(false)
                                    rendererBox.renderer?.setPointClickMode(false)
                                    topDownOrthoSlider = Double(rendererBox.renderer?.topDownOrthoHalfExtent ?? 10)
                                }
                                rendererBox.renderer?.setTopDownMode(enabled)
                                topDownPhase = rendererBox.renderer?.topDownPhase ?? .off
                                topDownStatus = rendererBox.renderer?.topDownStatus ?? topDownStatus
                            }
                            .buttonStyle(.borderedProminent)
                            .tint(isTopDownMode ? Color(red: 0.55, green: 0.35, blue: 0.85) : .accentColor)

                            if isTopDownMode || topDownStatus != "Top Down off" {
                                Text(topDownStatus)
                                    .font(.system(.caption, design: .monospaced))
                                    .foregroundStyle(.white)
                                    .padding(.horizontal, 10)
                                    .padding(.vertical, 8)
                                    .background(.black.opacity(0.55), in: RoundedRectangle(cornerRadius: 8))
                            }

                            if isTopDownMode {
                                if topDownPhase == .adjusting {
                                    HStack(spacing: 8) {
                                        Button("Up") {
                                            rendererBox.renderer?.nudgeTopDownHeight(Float(heightNudgeSensitivity))
                                            topDownPhase = rendererBox.renderer?.topDownPhase ?? .adjusting
                                            topDownStatus = rendererBox.renderer?.topDownStatus ?? topDownStatus
                                        }
                                        .buttonStyle(.borderedProminent)
                                        Button("Down") {
                                            rendererBox.renderer?.nudgeTopDownHeight(-Float(heightNudgeSensitivity))
                                            topDownPhase = rendererBox.renderer?.topDownPhase ?? .adjusting
                                            topDownStatus = rendererBox.renderer?.topDownStatus ?? topDownStatus
                                        }
                                        .buttonStyle(.borderedProminent)
                                        Button("Cut") {
                                            rendererBox.cameraView?.setMouseLookActive(false)
                                            rendererBox.renderer?.applyTopDownCut()
                                            topDownPhase = rendererBox.renderer?.topDownPhase ?? .cut
                                            topDownStatus = rendererBox.renderer?.topDownStatus ?? topDownStatus
                                        }
                                        .buttonStyle(.borderedProminent)
                                        .tint(Color(red: 0.9, green: 0.35, blue: 0.35))
                                    }

                                    VStack(alignment: .leading, spacing: 6) {
                                        Text(String(format: "Height step · %.2f m", heightNudgeSensitivity))
                                            .font(.caption)
                                            .foregroundStyle(.white)
                                        Slider(value: $heightNudgeSensitivity, in: 0.01...0.5, step: 0.01)
                                            .frame(width: 180)
                                    }
                                    .padding(.horizontal, 10)
                                    .padding(.vertical, 8)
                                    .background(.black.opacity(0.45), in: RoundedRectangle(cornerRadius: 8))
                                }

                                if topDownPhase == .cut {
                                    HStack(spacing: 8) {
                                        Button("Recut") {
                                            rendererBox.renderer?.clearTopDownCut()
                                            topDownPhase = rendererBox.renderer?.topDownPhase ?? .adjusting
                                            topDownStatus = rendererBox.renderer?.topDownStatus ?? topDownStatus
                                        }
                                        .buttonStyle(.borderedProminent)
                                        Button("Save Cut") {
                                            rendererBox.renderer?.saveTopDownCutForExport()
                                            topDownStatus = rendererBox.renderer?.topDownStatus ?? topDownStatus
                                        }
                                        .buttonStyle(.borderedProminent)
                                        .tint(Color(red: 0.3, green: 0.75, blue: 0.45))
                                    }

                                    HStack(spacing: 8) {
                                        Button("Save Max Zoom In") {
                                            rendererBox.renderer?.saveTopDownMaxZoomIn()
                                            topDownStatus = rendererBox.renderer?.topDownStatus ?? topDownStatus
                                        }
                                        .buttonStyle(.borderedProminent)
                                        .tint(Color(red: 0.2, green: 0.55, blue: 0.95))
                                        Button("Save Max Zoom Out") {
                                            rendererBox.renderer?.saveTopDownMaxZoomOut()
                                            topDownStatus = rendererBox.renderer?.topDownStatus ?? topDownStatus
                                        }
                                        .buttonStyle(.borderedProminent)
                                        .tint(Color(red: 0.2, green: 0.55, blue: 0.95))
                                    }

                                    VStack(alignment: .leading, spacing: 6) {
                                        Text(String(format: "Height · %.2f m view width (W/S @ move speed)", topDownOrthoSlider))
                                            .font(.caption)
                                            .foregroundStyle(.white)
                                        Slider(value: $topDownOrthoSlider, in: 0.001...500, step: 0.001)
                                            .frame(width: 180)
                                            .onChange(of: topDownOrthoSlider) { _, value in
                                                guard !topDownSliderSync.isSyncing else { return }
                                                rendererBox.renderer?.setTopDownViewWidth(Float(value))
                                            }
                                    }
                                    .padding(.horizontal, 10)
                                    .padding(.vertical, 8)
                                    .background(.black.opacity(0.45), in: RoundedRectangle(cornerRadius: 8))
                                }
                            }

                            if measureMode || measureStatus != "Measure off" {
                                Text(measureStatus)
                                    .font(.system(.caption, design: .monospaced))
                                    .foregroundStyle(.white)
                                    .padding(.horizontal, 10)
                                    .padding(.vertical, 8)
                                    .background(.black.opacity(0.55), in: RoundedRectangle(cornerRadius: 8))
                            }

                            if measureMode {
                                HStack(spacing: 8) {
                                    Button("Undo") {
                                        _ = rendererBox.renderer?.undoMeasurePoint()
                                        measureStatus = rendererBox.renderer?.measureStatus ?? measureStatus
                                        measureLabelOverlays = rendererBox.renderer?.measureLabelOverlays ?? []
                                        lastRawSegmentMeters = rendererBox.renderer?.lastRawSegmentMeters
                                    }
                                    Button("Clear") {
                                        rendererBox.renderer?.clearMeasureGeometry()
                                        measureLabelOverlays = []
                                        lastRawSegmentMeters = nil
                                        measureStatus = rendererBox.renderer?.measureStatus ?? measureStatus
                                    }
                                    Button("Reset Factor") {
                                        rendererBox.renderer?.resetMeasureCalibration()
                                        measureCalibrationFactor = rendererBox.renderer?.measureCalibrationFactor ?? 1.0
                                        measureStatus = rendererBox.renderer?.measureStatus ?? measureStatus
                                        measureLabelOverlays = rendererBox.renderer?.measureLabelOverlays ?? []
                                    }
                                }

                                VStack(alignment: .leading, spacing: 6) {
                                    if let raw = lastRawSegmentMeters {
                                        Text(String(format: "Raw length: %.2f cm", raw * 100))
                                            .font(.system(.caption, design: .monospaced))
                                            .foregroundStyle(.white)
                                    } else {
                                        Text("Click both ends of a known length")
                                            .font(.caption)
                                            .foregroundStyle(.white.opacity(0.85))
                                    }

                                    HStack(spacing: 8) {
                                        TextField("Actual cm", text: $actualLengthCmText)
                                            .textFieldStyle(.roundedBorder)
                                            .frame(width: 100)
#if os(iOS)
                                            .keyboardType(.decimalPad)
#endif
                                        Button("Calibrate") {
                                            let cleaned = actualLengthCmText
                                                .replacingOccurrences(of: ",", with: ".")
                                                .trimmingCharacters(in: .whitespacesAndNewlines)
                                            guard let cm = Float(cleaned) else { return }
                                            if let factor = rendererBox.renderer?.calibrateMeasure(actualCentimeters: cm) {
                                                measureCalibrationFactor = factor
                                            }
                                            measureStatus = rendererBox.renderer?.measureStatus ?? measureStatus
                                            measureLabelOverlays = rendererBox.renderer?.measureLabelOverlays ?? []
                                        }
                                        .buttonStyle(.borderedProminent)
                                        .tint(.green)
                                        .disabled(lastRawSegmentMeters == nil)
                                    }

                                    Text(String(format: "Calibration factor: %.8f", measureCalibrationFactor))
                                        .font(.system(.caption, design: .monospaced))
                                        .foregroundStyle(Color(red: 0.45, green: 1.0, blue: 0.55))
                                        .textSelection(.enabled)

                                    Text("Save this factor in the DB for MacApp.")
                                        .font(.caption2)
                                        .foregroundStyle(.white.opacity(0.7))
                                }
                                .padding(10)
                                .background(.black.opacity(0.55), in: RoundedRectangle(cornerRadius: 8))
                            }

                            if pointClickMode || pointClickStatus != "Point Click off" {
                                Text(pointClickStatus)
                                    .font(.system(.caption, design: .monospaced))
                                    .foregroundStyle(.white)
                                    .padding(.horizontal, 10)
                                    .padding(.vertical, 8)
                                    .background(.black.opacity(0.55), in: RoundedRectangle(cornerRadius: 8))
                            }

                            if pointClickMode {
                                VStack(alignment: .leading, spacing: 6) {
                                    Text("Photo API URL")
                                        .font(.caption)
                                        .foregroundStyle(.white.opacity(0.85))
                                    TextField("https://…", text: $photoAPIURLText)
                                        .textFieldStyle(.roundedBorder)
                                        .font(.system(.caption, design: .monospaced))
                                        .frame(minWidth: 220, maxWidth: 320)
#if os(iOS)
                                        .textInputAutocapitalization(.never)
                                        .keyboardType(.URL)
                                        .autocorrectionDisabled()
#endif
                                        .onSubmit { applyPhotoAPIURLFromField() }
                                        .onChange(of: photoAPIURLText) { _, _ in
                                            applyPhotoAPIURLFromField()
                                        }

                                    Toggle(isOn: Binding(
                                        get: { photoSearchUsesSPZCoordinates },
                                        set: { enabled in
                                            photoSearchUsesSPZCoordinates = enabled
                                            rendererBox.renderer?.setPhotoSearchUsesSPZCoordinates(enabled)
                                        }
                                    )) {
                                        Text("SPZ coordinates")
                                            .font(.caption)
                                    }
                                    .toggleStyle(.switch)
                                    .help("Off (default) = send display coords as-is. On = apply PLY 180° Z undo.")
                                }
                                .padding(10)
                                .background(.black.opacity(0.45), in: RoundedRectangle(cornerRadius: 8))
                            }

                            Button(isPlacingCollisionBlocks ? "Adding Block…" : "Add Block Collision") {
                                let enabled = !isPlacingCollisionBlocks
                                if enabled {
                                    isSelectingCollisionBlocks = false
                                    isRecordingCollision = false
                                    isRecordingStairs = false
                                    isRecordingClickCollision = false
                                    isSettingCameraAngles = false
                                    isSettingStartPoint = false
                                    showMoveSpeedControls = false
                                    showMeasureSizeControls = false
                                    pointClickMode = false
                                    measureMode = false
                                    rendererBox.renderer?.setPointClickMode(false)
                                    rendererBox.renderer?.setMeasureMode(false)
                                    rendererBox.renderer?.setCameraAnglesMode(false)
                                    rendererBox.renderer?.setStartPointMode(false)
                                    if let renderer = rendererBox.renderer {
                                        blockSize = Double(renderer.placementBlockSize)
                                    }
                                }
#if os(macOS)
                                if enabled {
                                    rendererBox.cameraView?.setMouseLookActive(false)
                                }
#endif
                                rendererBox.renderer?.setCollisionBlockPlacement(enabled)
                                isPlacingCollisionBlocks = enabled
                            }
                            .buttonStyle(.borderedProminent)
                            .tint(isPlacingCollisionBlocks ? .red : .accentColor)

                            Button(isRecordingClickCollision ? "Click Collision: On" : "Click Collision") {
                                let enabled = !isRecordingClickCollision
                                if enabled {
                                    isPlacingCollisionBlocks = false
                                    isSelectingCollisionBlocks = false
                                    isRecordingCollision = false
                                    isRecordingStairs = false
                                    isRecordingClickCollision = false
                                    isSettingCameraAngles = false
                                    isSettingStartPoint = false
                                    showMoveSpeedControls = false
                                    showMeasureSizeControls = false
                                    pointClickMode = false
                                    rendererBox.renderer?.setPointClickMode(false)
                                    rendererBox.renderer?.setCameraAnglesMode(false)
                                    rendererBox.renderer?.setStartPointMode(false)
                                }
#if os(macOS)
                                if enabled {
                                    rendererBox.cameraView?.setMouseLookActive(false)
                                }
#endif
                                rendererBox.renderer?.setClickCollisionRecording(enabled)
                                isRecordingClickCollision = enabled
                            }
                            .buttonStyle(.borderedProminent)
                            .tint(isRecordingClickCollision ? .orange : .accentColor)

                            if isRecordingClickCollision {
                                Button("Undo Point") {
                                    _ = rendererBox.renderer?.undoClickCollisionPoint()
                                }
                                .buttonStyle(.bordered)
                                .disabled((rendererBox.renderer?.recordedClickCollisionPoints.isEmpty) ?? true)

                                TimelineView(.periodic(from: .now, by: 0.2)) { _ in
                                    let count = rendererBox.renderer?.recordedClickCollisionPoints.count ?? 0
                                    let blocks = rendererBox.renderer?.collisionBlocks.count ?? 0
                                    Text(clickCollisionHint(pointCount: count, blockCount: blocks))
                                        .font(.caption)
                                        .foregroundStyle(.white)
                                        .padding(.horizontal, 8)
                                        .padding(.vertical, 6)
                                        .background(.black.opacity(0.45), in: RoundedRectangle(cornerRadius: 8))
                                }
                            }

                            Button(isRecordingCollision ? "Recording Walk…" : "Walking Collision") {
                                let enabled = !isRecordingCollision
                                if enabled {
                                    isPlacingCollisionBlocks = false
                                    isSelectingCollisionBlocks = false
                                    isRecordingStairs = false
                                    isRecordingClickCollision = false
                                    isSettingCameraAngles = false
                                    isSettingStartPoint = false
                                    showMoveSpeedControls = false
                                    showMeasureSizeControls = false
                                    pointClickMode = false
                                    rendererBox.renderer?.setPointClickMode(false)
                                    rendererBox.renderer?.setCameraAnglesMode(false)
                                    rendererBox.renderer?.setStartPointMode(false)
                                }
                                rendererBox.renderer?.setCollisionRecording(enabled)
                                isRecordingCollision = enabled
                            }
                            .buttonStyle(.borderedProminent)
                            .tint(isRecordingCollision ? .red : .accentColor)

                            Button(isSelectingCollisionBlocks ? "Select: On" : "Select") {
                                let enabled = !isSelectingCollisionBlocks
                                if enabled {
                                    isPlacingCollisionBlocks = false
                                    isRecordingCollision = false
                                    isRecordingStairs = false
                                    isRecordingClickCollision = false
                                    isSettingCameraAngles = false
                                    isSettingStartPoint = false
                                    showMoveSpeedControls = false
                                    showMeasureSizeControls = false
                                    pointClickMode = false
                                    rendererBox.renderer?.setPointClickMode(false)
                                    rendererBox.renderer?.setCameraAnglesMode(false)
                                    rendererBox.renderer?.setStartPointMode(false)
#if os(macOS)
                                    rendererBox.cameraView?.setMouseLookActive(false)
#endif
                                }
                                rendererBox.renderer?.setCollisionBlockSelecting(enabled)
                                isSelectingCollisionBlocks = enabled
                            }
                            .buttonStyle(.borderedProminent)
                            .tint(isSelectingCollisionBlocks ? .orange : .accentColor)

                            if isRecordingCollision {
                                TimelineView(.periodic(from: .now, by: 0.2)) { _ in
                                    let count = rendererBox.renderer?.recordedCollisionPoints.count ?? 0
                                    Text("Walk · \(count) samples · adds on top")
                                        .font(.caption)
                                        .foregroundStyle(.white)
                                        .padding(.horizontal, 8)
                                        .padding(.vertical, 6)
                                        .background(.black.opacity(0.45), in: RoundedRectangle(cornerRadius: 8))
                                }
                            }

                            if isPlacingCollisionBlocks {
                                Button("Undo Block") {
                                    _ = rendererBox.renderer?.undoCollisionBlock()
                                }
                                .buttonStyle(.bordered)
                                .disabled((rendererBox.renderer?.collisionBlocks.isEmpty) ?? true)

                                VStack(alignment: .leading, spacing: 8) {
                                    NumericParamControl(
                                        title: "Wall size",
                                        value: $blockSize,
                                        range: 0.001...Double(Constants.collisionBlockMaxWidth),
                                        suffix: "m"
                                    ) { value in
                                        rendererBox.renderer?.placementBlockSize = Float(value)
                                    }
                                    Text(
                                        String(
                                            format: "Thin wall · depth %.3fm",
                                            Constants.collisionBlockThickness(forFaceSize: Float(blockSize))
                                        )
                                    )
                                        .font(.caption2)
                                        .foregroundStyle(.white.opacity(0.85))
                                }
                                .padding(10)
                                .background(.black.opacity(0.45), in: RoundedRectangle(cornerRadius: 8))

                                TimelineView(.periodic(from: .now, by: 0.2)) { _ in
                                    let count = rendererBox.renderer?.collisionBlocks.count ?? 0
                                    Text("\(count) walls · click to place · snaps to neighbors")
                                        .font(.caption)
                                        .foregroundStyle(.white)
                                        .padding(.horizontal, 8)
                                        .padding(.vertical, 6)
                                        .background(.black.opacity(0.45), in: RoundedRectangle(cornerRadius: 8))
                                }
                            }

                            if isSelectingCollisionBlocks {
                                Button("Delete") {
                                    _ = rendererBox.renderer?.deleteSelectedCollisionBlock()
                                }
                                .buttonStyle(.bordered)
                                .disabled(rendererBox.renderer?.selectedCollisionBlockIndex == nil)

                                TimelineView(.periodic(from: .now, by: 0.2)) { _ in
                                    if let index = rendererBox.renderer?.selectedCollisionBlockIndex,
                                       let blocks = rendererBox.renderer?.collisionBlocks,
                                       blocks.indices.contains(index) {
                                        let block = blocks[index]
                                        Text(
                                            String(
                                                format: "Selected · W %.2fm  H %.2fm · drag to resize",
                                                block.width,
                                                block.height
                                            )
                                        )
                                        .font(.caption)
                                        .foregroundStyle(.white)
                                        .padding(.horizontal, 8)
                                        .padding(.vertical, 6)
                                        .background(.black.opacity(0.45), in: RoundedRectangle(cornerRadius: 8))
                                    } else {
                                        Text("Click a wall to select · drag resizes · Delete removes")
                                            .font(.caption)
                                            .foregroundStyle(.white)
                                            .padding(.horizontal, 8)
                                            .padding(.vertical, 6)
                                            .background(.black.opacity(0.45), in: RoundedRectangle(cornerRadius: 8))
                                    }
                                }
                            } else if isRecordingCollision {
                                TimelineView(.periodic(from: .now, by: 0.2)) { _ in
                                    let count = rendererBox.renderer?.collisionBlocks.count ?? 0
                                    Text("\(count) walls visible · walk adds outline collision")
                                        .font(.caption)
                                        .foregroundStyle(.white)
                                        .padding(.horizontal, 8)
                                        .padding(.vertical, 6)
                                        .background(.black.opacity(0.45), in: RoundedRectangle(cornerRadius: 8))
                                }
                            }

                            Button(isRecordingStairs ? "Stair Mode: On" : "Mark Stairs") {
                                let enabled = !isRecordingStairs
                                if enabled {
                                    isPlacingCollisionBlocks = false
                                    isSelectingCollisionBlocks = false
                                    isRecordingCollision = false
                                    isRecordingClickCollision = false
                                    isSettingCameraAngles = false
                                    isSettingStartPoint = false
                                    showMoveSpeedControls = false
                                    showMeasureSizeControls = false
                                    rendererBox.renderer?.setCameraAnglesMode(false)
                                    rendererBox.renderer?.setStartPointMode(false)
                                }
#if os(macOS)
                                if enabled {
                                    rendererBox.cameraView?.setMouseLookActive(false)
                                }
#endif
                                rendererBox.renderer?.setStairRecording(enabled)
                                isRecordingStairs = enabled
                            }
                            .buttonStyle(.borderedProminent)
                            .tint(isRecordingStairs ? .purple : .accentColor)

                            if isRecordingStairs {
                                Button("Undo Stair Point") {
                                    _ = rendererBox.renderer?.undoStairPoint()
                                }
                                .buttonStyle(.bordered)
                                .disabled((rendererBox.renderer?.recordedStairPoints.isEmpty) ?? true)

                                TimelineView(.periodic(from: .now, by: 0.2)) { _ in
                                    let count = rendererBox.renderer?.recordedStairPoints.count ?? 0
                                    Text(stairMarkHint(pointCount: count))
                                        .font(.caption)
                                        .foregroundStyle(.white)
                                        .padding(.horizontal, 8)
                                        .padding(.vertical, 6)
                                        .background(.black.opacity(0.45), in: RoundedRectangle(cornerRadius: 8))
                                }
                            }

                            Button(isSettingCameraAngles ? "Set Camera Angles: On" : "Set Camera Angles") {
                                let enabled = !isSettingCameraAngles
                                if enabled {
                                    isPlacingCollisionBlocks = false
                                    isSelectingCollisionBlocks = false
                                    isRecordingCollision = false
                                    isRecordingStairs = false
                                    isRecordingClickCollision = false
                                    isSettingStartPoint = false
                                    showMoveSpeedControls = false
                                    showMeasureSizeControls = false
                                    pointClickMode = false
                                    rendererBox.renderer?.setPointClickMode(false)
                                    rendererBox.renderer?.setCollisionBlockPlacement(false)
                                    rendererBox.renderer?.setCollisionBlockSelecting(false)
                                    rendererBox.renderer?.setCollisionRecording(false)
                                    rendererBox.renderer?.setClickCollisionRecording(false)
                                    rendererBox.renderer?.setStairRecording(false)
                                    rendererBox.renderer?.setStartPointMode(false)
                                }
                                rendererBox.renderer?.setCameraAnglesMode(enabled)
                                isSettingCameraAngles = enabled
                            }
                            .buttonStyle(.borderedProminent)
                            .tint(isSettingCameraAngles ? .cyan : .accentColor)

                            if isSettingCameraAngles {
                                Text("Look at a tilted side → Rotate ± (or Lock From View) rolls ONLY around where you look. Other sides stay. Save keeps it.")
                                    .font(.caption)
                                    .foregroundStyle(.white)
                                    .padding(.horizontal, 8)
                                    .padding(.vertical, 6)
                                    .background(.black.opacity(0.45), in: RoundedRectangle(cornerRadius: 8))

                                Button("Lock From View") {
                                    rendererBox.renderer?.lockCameraAnglesFromCurrentView(exitMode: false)
                                }
                                .buttonStyle(.borderedProminent)
                                .tint(.cyan)
                                .help("Roll the floor frame around your current look axis only — does not redefine forward.")

                                HStack(spacing: 8) {
                                    Button("Rotate −") {
                                        rendererBox.renderer?.rotateCameraView(
                                            degrees: -Float(cameraRotateSensitivity)
                                        )
                                    }
                                    .buttonStyle(.borderedProminent)

                                    Button("Rotate +") {
                                        rendererBox.renderer?.rotateCameraView(
                                            degrees: Float(cameraRotateSensitivity)
                                        )
                                    }
                                    .buttonStyle(.borderedProminent)
                                }

                                VStack(alignment: .leading, spacing: 6) {
                                    Text(String(format: "Rotate step · %.0f°", cameraRotateSensitivity))
                                        .font(.caption)
                                        .foregroundStyle(.white)
                                    Slider(value: $cameraRotateSensitivity, in: 1...180, step: 1)
                                        .frame(width: 180)
                                }
                                .padding(.horizontal, 10)
                                .padding(.vertical, 8)
                                .background(.black.opacity(0.45), in: RoundedRectangle(cornerRadius: 8))
                            }

                            Button(isSettingStartPoint ? "Start Point: On" : "Set Start Point") {
                                let enabled = !isSettingStartPoint
                                if enabled {
                                    isPlacingCollisionBlocks = false
                                    isSelectingCollisionBlocks = false
                                    isRecordingCollision = false
                                    isRecordingStairs = false
                                    isRecordingClickCollision = false
                                    isSettingCameraAngles = false
                                    showMoveSpeedControls = false
                                    showMeasureSizeControls = false
                                    pointClickMode = false
                                    rendererBox.renderer?.setPointClickMode(false)
                                    rendererBox.renderer?.setCollisionBlockPlacement(false)
                                    rendererBox.renderer?.setCollisionBlockSelecting(false)
                                    rendererBox.renderer?.setCollisionRecording(false)
                                    rendererBox.renderer?.setClickCollisionRecording(false)
                                    rendererBox.renderer?.setStairRecording(false)
                                    rendererBox.renderer?.setCameraAnglesMode(false)
                                }
                                rendererBox.renderer?.setStartPointMode(enabled)
                                isSettingStartPoint = enabled
                            }
                            .buttonStyle(.borderedProminent)
                            .tint(isSettingStartPoint ? .mint : .accentColor)

                            if isSettingStartPoint {
                                HStack(spacing: 8) {
                                    Button("Up") {
                                        rendererBox.renderer?.nudgeCameraHeight(Float(heightNudgeSensitivity))
                                    }
                                    .buttonStyle(.borderedProminent)

                                    Button("Down") {
                                        rendererBox.renderer?.nudgeCameraHeight(-Float(heightNudgeSensitivity))
                                    }
                                    .buttonStyle(.borderedProminent)
                                }

                                VStack(alignment: .leading, spacing: 6) {
                                    Text(String(format: "Height step · %.2f m", heightNudgeSensitivity))
                                        .font(.caption)
                                        .foregroundStyle(.white)
                                    Slider(value: $heightNudgeSensitivity, in: 0.01...0.5, step: 0.01)
                                        .frame(width: 180)
                                }
                                .padding(.horizontal, 10)
                                .padding(.vertical, 8)
                                .background(.black.opacity(0.45), in: RoundedRectangle(cornerRadius: 8))

                                Text("Walk to position · Up/Down height · keep mode On · then Save")
                                    .font(.caption)
                                    .foregroundStyle(.white)
                                    .padding(.horizontal, 8)
                                    .padding(.vertical, 6)
                                    .background(.black.opacity(0.45), in: RoundedRectangle(cornerRadius: 8))
                            }

                            Button(showMoveSpeedControls ? "Movement Speed: On" : "Movement Speed") {
                                showMoveSpeedControls.toggle()
                                if showMoveSpeedControls {
                                    showMeasureSizeControls = false
                                    moveSpeedSlider = Double(rendererBox.renderer?.cameraMoveSpeed ?? Constants.cameraMoveSpeed)
                                }
                            }
                            .buttonStyle(.borderedProminent)
                            .tint(showMoveSpeedControls ? .yellow : .accentColor)

                            if showMoveSpeedControls {
                                VStack(alignment: .leading, spacing: 8) {
                                    NumericParamControl(
                                        title: "Walk speed",
                                        value: $moveSpeedSlider,
                                        range: 0.001...12,
                                        suffix: "m/s"
                                    ) { value in
                                        rendererBox.renderer?.cameraMoveSpeed = Float(value)
                                    }
                                }
                                .padding(10)
                                .background(.black.opacity(0.45), in: RoundedRectangle(cornerRadius: 8))
                            }

                            Button(showMeasureSizeControls ? "Measure Size: On" : "Measure Size") {
                                showMeasureSizeControls.toggle()
                                if showMeasureSizeControls {
                                    showMoveSpeedControls = false
                                    measureSizeSlider = Double(rendererBox.renderer?.measureOverlayScale ?? 1.0)
                                }
                            }
                            .buttonStyle(.borderedProminent)
                            .tint(showMeasureSizeControls ? Color(red: 0.2, green: 0.85, blue: 0.95) : .accentColor)

                            if showMeasureSizeControls {
                                VStack(alignment: .leading, spacing: 8) {
                                    NumericParamControl(
                                        title: "Pins / lines / snap",
                                        value: $measureSizeSlider,
                                        range: 0.05...2.0,
                                        suffix: "×"
                                    ) { value in
                                        rendererBox.renderer?.measureOverlayScale = Float(value)
                                    }
                                    Text("Lower for small splats. Saved in nav.txt.")
                                        .font(.caption2)
                                        .foregroundStyle(.white.opacity(0.75))
                                }
                                .padding(10)
                                .background(.black.opacity(0.45), in: RoundedRectangle(cornerRadius: 8))
                            }

                            Button("Reset Collision") {
                                isPlacingCollisionBlocks = false
                                isSelectingCollisionBlocks = false
                                isRecordingCollision = false
                                isRecordingClickCollision = false
                                rendererBox.renderer?.resetCollision()
                            }
                            .buttonStyle(.borderedProminent)

                            Button("Reset Stairs") {
                                isRecordingStairs = false
                                rendererBox.renderer?.resetStairs()
                            }
                            .buttonStyle(.borderedProminent)
                        }

                        Spacer(minLength: 0)

                        TimelineView(.periodic(from: .now, by: 0.5)) { _ in
                            VStack(alignment: .trailing, spacing: 6) {
                                if modelIdentifier != nil {
                                    Text(memoryUsageText)
                                        .font(.system(.caption, design: .monospaced))
                                        .foregroundStyle(.white)
                                        .padding(.horizontal, 10)
                                        .padding(.vertical, 8)
                                        .background(.black.opacity(0.55), in: RoundedRectangle(cornerRadius: 8))
                                }

                                Text(cameraDebugText)
                                    .font(.system(.caption, design: .monospaced))
                                    .foregroundStyle(.white)
                                    .multilineTextAlignment(.trailing)
                                    .padding(.horizontal, 10)
                                    .padding(.vertical, 8)
                                    .background(.black.opacity(0.55), in: RoundedRectangle(cornerRadius: 8))
                            }
                        }
                    }

                    Spacer(minLength: 0)

                    HStack(alignment: .bottom) {
                        VStack(alignment: .leading, spacing: 8) {
                            Button("Save") {
#if os(macOS)
                                // Flush any in-progress text-field edits (speed, wall size, etc.).
                                NSApp.keyWindow?.makeFirstResponder(nil)
#endif
                                // Commit UI values before applying / serializing.
                                rendererBox.renderer?.cameraMoveSpeed = Float(moveSpeedSlider)
                                rendererBox.renderer?.placementBlockSize = Float(blockSize)
                                rendererBox.renderer?.saveNavigation()
                                isPlacingCollisionBlocks = false
                                isSelectingCollisionBlocks = false
                                isRecordingCollision = false
                                isRecordingClickCollision = false
                                isRecordingStairs = false
                                isSettingCameraAngles = false
                                isSettingStartPoint = false
                                showMoveSpeedControls = false
                                showMeasureSizeControls = false
                            }
                            .buttonStyle(.borderedProminent)
                            .tint(.green)

                            Button("Download TXT") {
                                downloadNavigationTXT()
                            }
                            .buttonStyle(.borderedProminent)
                        }

                        Spacer(minLength: 0)

#if os(macOS)
                        Text(helpCaption)
                            .font(.caption)
                            .padding(8)
                            .background(.black.opacity(0.45), in: RoundedRectangle(cornerRadius: 8))
#elseif os(iOS)
                        MovementPad(rendererBox: rendererBox, showVertical: isRecordingStairs || isSettingCameraAngles || isSettingStartPoint || topDownPhase == .adjusting || topDownPhase == .cut)
#endif
                    }
                }
                .padding()
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            }

            if showPhotoPanel && pointClickMode {
                Divider()
                PhotoSearchSidePanel(
                    photos: searchedPhotos,
                    isLoading: isPhotoSearching,
                    isFetchingMore: isFetchingMorePhotos,
                    hasMore: hasMorePhotos,
                    statusText: pointClickStatus,
                    apiBaseURL: rendererBox.renderer?.photoAPIBaseURL ?? PhotoSearchAPI.baseURL,
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
#if os(iOS)
        .fileExporter(
            isPresented: $isExportingNavigation,
            document: exportDocument,
            contentType: .plainText,
            defaultFilename: "nav"
        ) { _ in
        }
#endif
    }

    private func applyPhotoAPIURLFromField() {
        let trimmed = photoAPIURLText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        if rendererBox.renderer?.setPhotoAPIBaseURL(fromString: trimmed) == true {
            UserDefaults.standard.set(trimmed, forKey: "SampleApp.photoAPIBaseURL")
        }
    }

    private var helpCaption: String {
        if pointClickMode {
            return "Point Click on · click a surface to search photos · Esc exits look · toggle button to leave mode"
        }
        if topDownPhase == .adjusting {
            return "Top Down · Up/Down or Q/E sets cut height · roof above you is preview-clipped · Cut locks floor plan"
        }
        if topDownPhase == .cut {
            return "Top Down cut · Save Cut · fly to limits · Save Max Zoom In/Out · Download TXT (no extra Save needed)"
        }
        if isSettingCameraAngles {
            return "Set Camera Angles · Rotate ± / Lock rolls only around where you look · Save keeps it"
        }
        if isSettingStartPoint {
            return "Set Start Point · walk into place · Up/Down for height · Save stores spawn pose"
        }
        if isRecordingStairs {
            return "Mark Stairs · click corners · Q/E moves camera · need ≥3 · toggle off to append · Save to apply"
        }
        if isRecordingClickCollision {
            return "Click Collision · click 3–4 surface corners · thin barrier only · 4th click (or toggle off at 3) · Save"
        }
        if isSelectingCollisionBlocks {
            return "Select · click a wall · drag to resize width/height · Delete removes it · right-click looks"
        }
        if isPlacingCollisionBlocks {
            return "Add Block Collision · left-click places a thin wall · free float · neighbors snap · Save"
        }
        if isRecordingCollision {
            return "Walking Collision · walk the area · toggle off to append outline · walls stay visible · Save"
        }
        return "Add Block / Click Collision / Walking · Save applies live · Download TXT exports nav.txt"
    }

    private func clickCollisionHint(pointCount: Int, blockCount: Int) -> String {
        switch pointCount {
        case 0:
            return "\(blockCount) barriers · click 3–4 corners (thin walls)"
        case 1:
            return "1/\(pointCount < 4 ? "3–4" : "4") · click next corner"
        case 2:
            return "2/3–4 · click next corner"
        case 3:
            return "3 points · click 4th or toggle off to create thin barrier"
        default:
            return "\(blockCount) barriers · click 3–4 corners for another"
        }
    }

    private func stairMarkHint(pointCount: Int) -> String {
        switch pointCount {
        case 0:
            return "Click corners on the stair surface"
        case 1:
            return "1 corner · need 2 more"
        case 2:
            return "2 corners · click 1 more"
        default:
            return "\(pointCount) corners · toggle off to append · Save to apply"
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

    private var memoryUsageText: String {
        guard let bytes = ProcessMemory.physFootprintBytes() else {
            return "mem: —"
        }
        return "mem: \(Self.formatBytes(bytes))"
    }

    private static func formatBytes(_ bytes: UInt64) -> String {
        let mb = Double(bytes) / (1024 * 1024)
        if mb >= 1024 {
            return String(format: "%.2f GB", mb / 1024)
        }
        return String(format: "%.0f MB", mb)
    }

    private func downloadNavigationTXT() {
#if os(macOS)
        NSApp.keyWindow?.makeFirstResponder(nil)
#endif
        rendererBox.renderer?.cameraMoveSpeed = Float(moveSpeedSlider)
        rendererBox.renderer?.placementBlockSize = Float(blockSize)
        guard let text = rendererBox.renderer?.navigationExportText() else { return }
#if os(macOS)
        let panel = NSSavePanel()
        panel.allowedContentTypes = [.plainText]
        panel.canCreateDirectories = true
        panel.isExtensionHidden = false
        panel.nameFieldStringValue = "nav.txt"
        panel.begin { response in
            guard response == .OK, let url = panel.url else { return }
            try? text.write(to: url, atomically: true, encoding: .utf8)
        }
#elseif os(iOS)
        exportDocument = CollisionPathDocument(text: text)
        isExportingNavigation = true
#endif
    }
}

#if os(iOS)
private struct CollisionPathDocument: FileDocument {
    static var readableContentTypes: [UTType] { [.plainText] }

    var text: String

    init(text: String) {
        self.text = text
    }

    init(configuration: ReadConfiguration) throws {
        text = configuration.file.regularFileContents
            .flatMap { String(data: $0, encoding: .utf8) } ?? ""
    }

    func fileWrapper(configuration: WriteConfiguration) throws -> FileWrapper {
        FileWrapper(regularFileWithContents: Data(text.utf8))
    }
}
#endif

@MainActor
final class RendererBox {
    var renderer: MetalKitSceneRenderer?
#if os(macOS)
    weak var cameraView: CameraControlMTKView?
#endif
}

/// Mutable gate for programmatic Top Down slider updates (avoids camera snap-back).
private final class TopDownSliderSyncGate {
    var isSyncing = false
}

#if os(iOS)
private struct MovementPad: View {
    let rendererBox: RendererBox
    var showVertical = false

    var body: some View {
        VStack(spacing: 8) {
            if showVertical {
                HStack(spacing: 8) {
                    holdButton(systemName: "chevron.up", set: { $0.up = $1 })
                    holdButton(systemName: "chevron.down", set: { $0.down = $1 })
                }
            }
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
    var onMeasureStateChanged: () -> Void
    var onTopDownStateChanged: () -> Void

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
        context.coordinator.renderer?.onMeasureStateChanged = onMeasureStateChanged
        context.coordinator.renderer?.onTopDownStateChanged = onTopDownStateChanged
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
        context.coordinator.renderer?.onMeasureStateChanged = onMeasureStateChanged
        context.coordinator.renderer?.onTopDownStateChanged = onTopDownStateChanged
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
        renderer?.onMeasureStateChanged = onMeasureStateChanged
        renderer?.onTopDownStateChanged = onTopDownStateChanged

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
        static let q: UInt16 = 12
        static let e: UInt16 = 14
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

        if renderer?.measureMode == true {
            setMouseLookActive(false)
            renderer?.handleMeasureClick(at: locationInView)
            return
        }

        if renderer?.pointClickMode == true {
            setMouseLookActive(false)
            renderer?.handlePointClick(at: locationInView)
            return
        }

        if renderer?.isRecordingStairs == true {
            setMouseLookActive(false)
            _ = renderer?.markStairPoint(at: locationInView)
            return
        }

        if renderer?.isRecordingClickCollision == true {
            setMouseLookActive(false)
            _ = renderer?.markClickCollisionPoint(at: locationInView)
            return
        }

        if renderer?.isSelectingCollisionBlocks == true {
            setMouseLookActive(false)
            _ = renderer?.selectCollisionBlock(at: locationInView)
            return
        }

        if renderer?.isPlacingCollisionBlocks == true {
            setMouseLookActive(false)
            _ = renderer?.placeCollisionBlock(at: locationInView)
            return
        }

        // Top Down keeps the cursor visible — look by dragging, no click-to-lock.
        if renderer?.topDownPhase == .cut || renderer?.topDownPhase == .adjusting {
            setMouseLookActive(false)
            return
        }

        setMouseLookActive(true)
    }

    override func rightMouseDown(with event: NSEvent) {
        window?.makeFirstResponder(self)
        // In place/select/stair mode, right-click toggles look so left-click can mark surfaces.
        if renderer?.measureMode == true {
            setMouseLookActive(false)
            return
        }
        if renderer?.isRecordingStairs == true
            || renderer?.isRecordingClickCollision == true
            || renderer?.isPlacingCollisionBlocks == true
            || renderer?.isSelectingCollisionBlocks == true
            || renderer?.pointClickMode == true {
            setMouseLookActive(!isMouseLookActive)
            return
        }
        setMouseLookActive(true)
    }

    override func mouseDragged(with event: NSEvent) {
        if renderer?.isSelectingCollisionBlocks == true, !isMouseLookActive {
            renderer?.resizeSelectedCollisionBlock(deltaX: event.deltaX, deltaY: event.deltaY)
            return
        }
        let topDownDragLook = renderer?.topDownPhase == .cut || renderer?.topDownPhase == .adjusting
        if topDownDragLook {
            renderer?.applyLookDelta(deltaX: event.deltaX, deltaY: event.deltaY)
            return
        }
        guard isMouseLookActive,
              renderer?.pointClickMode != true,
              renderer?.measureMode != true else { return }
        renderer?.applyLookDelta(deltaX: event.deltaX, deltaY: event.deltaY)
    }

    override func mouseMoved(with event: NSEvent) {
        if renderer?.measureMode == true {
            if isMouseLookActive { setMouseLookActive(false) }
            let locationInView = convert(event.locationInWindow, from: nil)
            renderer?.updateMeasureHover(at: locationInView)
            return
        }
        if renderer?.isPlacingCollisionBlocks == true, !isMouseLookActive {
            let locationInView = convert(event.locationInWindow, from: nil)
            renderer?.updateCollisionBlockPreview(at: locationInView)
        }
        guard isMouseLookActive,
              renderer?.pointClickMode != true,
              renderer?.measureMode != true else { return }
        renderer?.applyLookDelta(deltaX: event.deltaX, deltaY: event.deltaY)
    }

    override func keyDown(with event: NSEvent) {
        if event.keyCode == KeyCode.escape {
            setMouseLookActive(false)
            return
        }
        if renderer?.measureMode == true,
           event.charactersIgnoringModifiers == "z",
           event.modifierFlags.contains(.command) || event.modifierFlags.contains(.control) {
            _ = renderer?.undoMeasurePoint()
            return
        }
        // Forward Delete / Backspace removes the selected wall.
        if renderer?.isSelectingCollisionBlocks == true,
           event.keyCode == 51 || event.keyCode == 117 {
            _ = renderer?.deleteSelectedCollisionBlock()
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
        let stairRecording = renderer.isRecordingStairs
        let settingAngles = renderer.isSettingCameraAngles
        let settingStart = renderer.isSettingStartPoint
        let topDownFreeFly = renderer.topDownPhase == .adjusting || renderer.topDownPhase == .cut
        let allowVertical = stairRecording || settingAngles || settingStart || topDownFreeFly
        renderer.movement = .init(
            forward: pressedKeys.contains(KeyCode.w) || pressedKeys.contains(KeyCode.upArrow),
            backward: pressedKeys.contains(KeyCode.s) || pressedKeys.contains(KeyCode.downArrow),
            left: pressedKeys.contains(KeyCode.a) || pressedKeys.contains(KeyCode.leftArrow),
            right: pressedKeys.contains(KeyCode.d) || pressedKeys.contains(KeyCode.rightArrow),
            up: allowVertical && pressedKeys.contains(KeyCode.q),
            down: allowVertical && pressedKeys.contains(KeyCode.e)
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
        guard renderer?.pointClickMode != true,
              renderer?.isRecordingStairs != true,
              renderer?.isRecordingClickCollision != true,
              renderer?.isPlacingCollisionBlocks != true,
              renderer?.isSelectingCollisionBlocks != true else {
            // In select mode, drag resizes the selected wall.
            if renderer?.isSelectingCollisionBlocks == true,
               let touch = touches.first {
                let location = touch.location(in: self)
                let previous = touch.previousLocation(in: self)
                let dx = location.x - previous.x
                let dy = location.y - previous.y
                if hypot(dx, dy) > 0.5 {
                    didDragLook = true
                    renderer?.resizeSelectedCollisionBlock(deltaX: dx, deltaY: dy)
                }
            }
            return
        }
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

        guard !didDragLook,
              let location = touches.first?.location(in: self) else {
            return
        }

        if renderer?.isRecordingStairs == true {
            _ = renderer?.markStairPoint(at: location)
            return
        }

        if renderer?.isRecordingClickCollision == true {
            _ = renderer?.markClickCollisionPoint(at: location)
            return
        }

        if renderer?.isSelectingCollisionBlocks == true {
            _ = renderer?.selectCollisionBlock(at: location)
            return
        }

        if renderer?.isPlacingCollisionBlocks == true {
            _ = renderer?.placeCollisionBlock(at: location)
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

/// Slider + typed field for small float params (speed, block size, etc.).
private struct NumericParamControl: View {
    let title: String
    @Binding var value: Double
    let range: ClosedRange<Double>
    var suffix: String = ""
    var step: Double = 0.001
    let onCommit: (Double) -> Void

    @State private var text: String = ""
    @FocusState private var isEditing: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 8) {
                Text(title)
                    .font(.caption)
                    .foregroundStyle(.white)
                Spacer(minLength: 4)
                TextField("", text: $text)
                    .textFieldStyle(.roundedBorder)
                    .frame(width: 72)
                    .multilineTextAlignment(.trailing)
                    .focused($isEditing)
                    .onSubmit { commitText() }
#if os(macOS)
                    .onExitCommand { commitText() }
#endif
                    .onChange(of: text) { _, newText in
                        guard isEditing else { return }
                        let cleaned = newText
                            .trimmingCharacters(in: .whitespacesAndNewlines)
                            .replacingOccurrences(of: ",", with: ".")
                        guard let parsed = Double(cleaned) else { return }
                        let next = clamped(parsed)
                        if abs(value - next) > 1e-9 {
                            value = next
                        }
                        onCommit(next)
                    }
                if !suffix.isEmpty {
                    Text(suffix)
                        .font(.caption2)
                        .foregroundStyle(.white.opacity(0.85))
                        .frame(width: 28, alignment: .leading)
                }
            }
            Slider(value: $value, in: range, step: step)
                .frame(width: 200)
                .onChange(of: value) { _, newValue in
                    if !isEditing {
                        text = format(newValue)
                    }
                    onCommit(clamped(newValue))
                }
        }
        .onAppear {
            text = format(value)
        }
        .onChange(of: isEditing) { _, editing in
            if !editing {
                commitText()
            }
        }
        .onChange(of: value) { _, newValue in
            if !isEditing {
                text = format(newValue)
            }
        }
    }

    private func clamped(_ raw: Double) -> Double {
        min(range.upperBound, max(range.lowerBound, raw))
    }

    private func format(_ raw: Double) -> String {
        String(format: "%.3f", raw)
    }

    private func commitText() {
        let cleaned = text
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .replacingOccurrences(of: ",", with: ".")
        guard let parsed = Double(cleaned) else {
            text = format(value)
            return
        }
        let next = clamped(parsed)
        value = next
        text = format(next)
        onCommit(next)
    }
}

/// Process physical memory footprint (what Activity Monitor roughly shows as Memory).
private enum ProcessMemory {
    static func physFootprintBytes() -> UInt64? {
        var info = task_vm_info_data_t()
        var count = mach_msg_type_number_t(
            MemoryLayout<task_vm_info_data_t>.size / MemoryLayout<natural_t>.size
        )
        let kr = withUnsafeMutablePointer(to: &info) { infoPtr in
            infoPtr.withMemoryRebound(to: integer_t.self, capacity: Int(count)) { intPtr in
                task_info(mach_task_self_, task_flavor_t(TASK_VM_INFO), intPtr, &count)
            }
        }
        guard kr == KERN_SUCCESS else { return nil }
        return info.phys_footprint
    }
}

#endif // os(iOS) || os(macOS)
