import Foundation
import simd

/// One floor's collision path (samples near that standing height).
struct CollisionLayerData: Equatable, Hashable, Codable {
    var floorY: Float
    var points: [SIMD3<Float>]

    init(floorY: Float, points: [SIMD3<Float>]) {
        self.floorY = floorY
        self.points = points
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        floorY = try c.decode(Float.self, forKey: .floorY)
        points = try c.decode([[Float]].self, forKey: .points).map { SIMD3($0[0], $0[1], $0[2]) }
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(floorY, forKey: .floorY)
        try c.encode(points.map { [$0.x, $0.y, $0.z] }, forKey: .points)
    }

    private enum CodingKeys: String, CodingKey {
        case floorY, points
    }
}

/// Combined start / collision / stairs navigation for a splat scene.
struct SceneNavigationData: Equatable, Hashable, Codable {
    var startPosition: SIMD3<Float>
    var startYawRadians: Float
    var startPitchRadians: Float
    /// Optional gravity / floor-normal axis. When set with `orientationForward`, replaces the default Y-up frame.
    var orientationUp: SIMD3<Float>?
    /// Optional "straight ahead" direction (level). Used with `orientationUp`.
    var orientationForward: SIMD3<Float>?
    /// WASD / pad walk speed in meters per second. Nil = app default.
    var moveSpeed: Float?
    /// Multiplier for Measure tool pin / laser / reticle size. Nil = 1.0.
    var measureScale: Float?
    /// Collision layers by floor height. Empty = no walkable clamp.
    var collisionLayers: [CollisionLayerData]
    /// Solid wall bricks (Lego-style). Empty = none.
    var collisionBlocks: [CollisionBlock]
    /// One or more stair polygons (each needs ≥ 3 vertices).
    var stairPolygons: [[SIMD3<Float>]]

    var hasCustomOrientation: Bool {
        orientationUp != nil && orientationForward != nil
    }

    /// Flattened collision points (for export helpers / legacy call sites).
    var collisionPoints: [SIMD3<Float>] {
        collisionLayers.flatMap(\.points)
    }

    /// First stair polygon, or empty — legacy convenience.
    var stairVertices: [SIMD3<Float>] {
        stairPolygons.first ?? []
    }

    static let empty = SceneNavigationData(
        startPosition: SIMD3(0, Constants.cameraGroundY, Constants.cameraStartZ),
        startYawRadians: 0,
        startPitchRadians: 0,
        collisionLayers: [],
        collisionBlocks: [],
        stairPolygons: []
    )

    enum ParseError: LocalizedError {
        case empty
        case missingStart

        var errorDescription: String? {
            switch self {
            case .empty: return "Navigation file is empty"
            case .missingStart: return "Navigation file is missing a [start] section"
            }
        }
    }

    init(
        startPosition: SIMD3<Float>,
        startYawRadians: Float,
        startPitchRadians: Float,
        orientationUp: SIMD3<Float>? = nil,
        orientationForward: SIMD3<Float>? = nil,
        moveSpeed: Float? = nil,
        measureScale: Float? = nil,
        collisionLayers: [CollisionLayerData],
        collisionBlocks: [CollisionBlock] = [],
        stairPolygons: [[SIMD3<Float>]]
    ) {
        self.startPosition = startPosition
        self.startYawRadians = startYawRadians
        self.startPitchRadians = startPitchRadians
        self.orientationUp = orientationUp
        self.orientationForward = orientationForward
        self.moveSpeed = moveSpeed
        self.measureScale = measureScale
        self.collisionLayers = collisionLayers
        self.collisionBlocks = collisionBlocks
        self.stairPolygons = stairPolygons
    }

    /// Convenience: auto-cluster a flat collision list; optional single stair polygon.
    init(
        startPosition: SIMD3<Float>,
        startYawRadians: Float,
        startPitchRadians: Float,
        orientationUp: SIMD3<Float>? = nil,
        orientationForward: SIMD3<Float>? = nil,
        moveSpeed: Float? = nil,
        measureScale: Float? = nil,
        collisionPoints: [SIMD3<Float>],
        collisionBlocks: [CollisionBlock] = [],
        stairVertices: [SIMD3<Float>]
    ) {
        let clusters = WalkableCollisionBounds.clusterByHeight(
            collisionPoints,
            gap: Constants.collisionFloorClusterGap
        )
        self.init(
            startPosition: startPosition,
            startYawRadians: startYawRadians,
            startPitchRadians: startPitchRadians,
            orientationUp: orientationUp,
            orientationForward: orientationForward,
            moveSpeed: moveSpeed,
            measureScale: measureScale,
            collisionLayers: clusters.map { CollisionLayerData(floorY: $0.floorY, points: $0.points) },
            collisionBlocks: collisionBlocks,
            stairPolygons: stairVertices.count >= 3 ? [stairVertices] : []
        )
    }

    init(
        startPosition: SIMD3<Float>,
        startYawRadians: Float,
        startPitchRadians: Float,
        orientationUp: SIMD3<Float>? = nil,
        orientationForward: SIMD3<Float>? = nil,
        moveSpeed: Float? = nil,
        measureScale: Float? = nil,
        collisionPoints: [SIMD3<Float>],
        collisionBlocks: [CollisionBlock] = [],
        stairPolygons: [[SIMD3<Float>]]
    ) {
        let clusters = WalkableCollisionBounds.clusterByHeight(
            collisionPoints,
            gap: Constants.collisionFloorClusterGap
        )
        self.init(
            startPosition: startPosition,
            startYawRadians: startYawRadians,
            startPitchRadians: startPitchRadians,
            orientationUp: orientationUp,
            orientationForward: orientationForward,
            moveSpeed: moveSpeed,
            measureScale: measureScale,
            collisionLayers: clusters.map { CollisionLayerData(floorY: $0.floorY, points: $0.points) },
            collisionBlocks: collisionBlocks,
            stairPolygons: stairPolygons.filter { $0.count >= 3 }
        )
    }

    static func parse(_ text: String) throws -> SceneNavigationData {
        enum Section {
            case none, start, collision, stairs, blocks, orientation, settings
        }

        var section: Section = .none
        var startValues: [Float]?
        var stairPolygons: [[SIMD3<Float>]] = []
        var currentStairPoints: [SIMD3<Float>] = []
        var layers: [CollisionLayerData] = []
        var currentLayerFloor: Float?
        var currentLayerPoints: [SIMD3<Float>] = []
        var blocks: [CollisionBlock] = []
        var orientationVectors: [SIMD3<Float>] = []
        var moveSpeed: Float?
        var measureScale: Float?


        func flushStairPolygon() {
            guard currentStairPoints.count >= 3 else {
                currentStairPoints = []
                return
            }
            stairPolygons.append(currentStairPoints)
            currentStairPoints = []
        }

        func flushCollisionLayer() {
            guard !currentLayerPoints.isEmpty else {
                currentLayerFloor = nil
                return
            }
            let floor: Float
            if let currentLayerFloor {
                floor = currentLayerFloor
            } else {
                floor = currentLayerPoints.reduce(Float(0)) { $0 + $1.y } / Float(currentLayerPoints.count)
            }
            layers.append(CollisionLayerData(floorY: floor, points: currentLayerPoints))
            currentLayerPoints = []
            currentLayerFloor = nil
        }

        for rawLine in text.split(whereSeparator: \.isNewline) {
            let line = rawLine.trimmingCharacters(in: .whitespaces)
            if line.isEmpty || line.hasPrefix("#") { continue }

            let lowered = line.lowercased()
            if lowered == "[start]" {
                flushCollisionLayer()
                flushStairPolygon()
                section = .start
                continue
            }
            if lowered == "[orientation]" || lowered == "[camera-orientation]" {
                flushCollisionLayer()
                flushStairPolygon()
                section = .orientation
                continue
            }
            if lowered == "[settings]" || lowered == "[setting]" {
                flushCollisionLayer()
                flushStairPolygon()
                section = .settings
                continue
            }
            if lowered.hasPrefix("[collision") {
                flushCollisionLayer()
                flushStairPolygon()
                section = .collision
                currentLayerFloor = parseFloorAttribute(from: lowered)
                continue
            }
            if lowered == "[stairs]" || lowered == "[stair]" {
                flushCollisionLayer()
                flushStairPolygon()
                section = .stairs
                continue
            }
            if lowered == "[blocks]" || lowered == "[block]" {
                flushCollisionLayer()
                flushStairPolygon()
                section = .blocks
                continue
            }

            let parts = line.split(whereSeparator: \.isWhitespace).compactMap { Float($0) }
            switch section {
            case .none:
                continue
            case .start:
                guard parts.count >= 3 else { continue }
                startValues = parts
            case .orientation:
                guard parts.count >= 3 else { continue }
                orientationVectors.append(SIMD3(parts[0], parts[1], parts[2]))
            case .settings:
                // Labels like "measure_scale" are not floats, so parts is usually just [value].
                let loweredLine = line.lowercased()
                if loweredLine.contains("measure"), let value = parts.last, value > 0 {
                    measureScale = value
                } else if loweredLine.contains("move"), let value = parts.last, value > 0 {
                    moveSpeed = value
                } else if parts.count >= 1, moveSpeed == nil, parts[0] > 0 {
                    moveSpeed = parts[0]
                }
            case .collision:
                guard parts.count >= 3 else { continue }
                currentLayerPoints.append(SIMD3(parts[0], parts[1], parts[2]))
            case .stairs:
                guard parts.count >= 3 else { continue }
                currentStairPoints.append(SIMD3(parts[0], parts[1], parts[2]))
            case .blocks:
                // centerX centerZ baseY [width depth height yaw_degrees]
                guard parts.count >= 3 else { continue }
                let width = parts.count > 3 ? parts[3] : CollisionBlock.defaultWidth
                let depth = parts.count > 4 ? parts[4] : CollisionBlock.defaultDepth
                let height = parts.count > 5 ? parts[5] : CollisionBlock.defaultHeight
                let yawDeg = parts.count > 6 ? parts[6] : 0
                blocks.append(
                    CollisionBlock(
                        centerX: parts[0],
                        centerZ: parts[1],
                        baseY: parts[2],
                        width: width,
                        depth: depth,
                        height: height,
                        yawRadians: yawDeg * .pi / 180
                    )
                )
            }
        }
        flushCollisionLayer()
        flushStairPolygon()

        // Legacy single-layer files: if one layer has mixed heights, re-cluster.
        if layers.count == 1 {
            let clustered = WalkableCollisionBounds.clusterByHeight(
                layers[0].points,
                gap: Constants.collisionFloorClusterGap
            )
            if clustered.count > 1 {
                layers = clustered.map { CollisionLayerData(floorY: $0.floorY, points: $0.points) }
            }
        }

        guard let startValues, startValues.count >= 3 else {
            throw ParseError.missingStart
        }

        let yawDeg = startValues.count > 3 ? startValues[3] : 0
        let pitchDeg = startValues.count > 4 ? startValues[4] : 0

        var orientationUp: SIMD3<Float>?
        var orientationForward: SIMD3<Float>?
        if orientationVectors.count >= 2 {
            let up = orientationVectors[0]
            var forward = orientationVectors[1]
            let upLen = simd_length(up)
            let forwardLen = simd_length(forward)
            if upLen > 1e-5, forwardLen > 1e-5 {
                let upN = up / upLen
                forward = forward - simd_dot(forward, upN) * upN
                let flatLen = simd_length(forward)
                if flatLen > 1e-5 {
                    orientationUp = upN
                    orientationForward = forward / flatLen
                }
            }
        }

        return SceneNavigationData(
            startPosition: SIMD3(startValues[0], startValues[1], startValues[2]),
            startYawRadians: yawDeg * .pi / 180,
            startPitchRadians: pitchDeg * .pi / 180,
            orientationUp: orientationUp,
            orientationForward: orientationForward,
            moveSpeed: moveSpeed,
            measureScale: measureScale,
            collisionLayers: layers,
            collisionBlocks: blocks,
            stairPolygons: stairPolygons
        )
    }

    func serialize() -> String {
        var lines: [String] = [
            "# MetalSplatter scene navigation",
            "# version 2",
            "# Collision is height-banded: each [collision floor=Y] only applies near that camera height.",
            "# Between floors (stairs), no collision clamp is applied.",
            "",
            "[start]",
            "# x y z yaw_degrees pitch_degrees",
            String(
                format: "%.6f %.6f %.6f %.6f %.6f",
                startPosition.x,
                startPosition.y,
                startPosition.z,
                startYawRadians * 180 / .pi,
                startPitchRadians * 180 / .pi
            ),
        ]

        if let up = orientationUp, let forward = orientationForward {
            lines += [
                "",
                "[orientation]",
                "# Custom camera frame: line1 = up, line2 = forward (level / straight ahead)",
                "# After Save from Set Camera Angles, yaw/pitch 0 looks along forward with this up.",
                String(format: "%.6f %.6f %.6f", up.x, up.y, up.z),
                String(format: "%.6f %.6f %.6f", forward.x, forward.y, forward.z),
            ]
        }

        if moveSpeed != nil || measureScale != nil {
            lines += [
                "",
                "[settings]",
            ]
            if let moveSpeed {
                lines += [
                    "# move_speed meters_per_second (WASD / pad walk speed, not look sensitivity)",
                    String(format: "move_speed %.6f", moveSpeed),
                ]
            }
            if let measureScale {
                lines += [
                    "# measure_scale multiplies Measure pin / laser / reticle size (1.0 = default)",
                    String(format: "measure_scale %.6f", measureScale),
                ]
            }
        }

        if collisionLayers.isEmpty {
            lines += ["", "[collision]", "# (none)"]
        } else {
            for layer in collisionLayers {
                lines += [
                    "",
                    String(format: "[collision floor=%.6f]", layer.floorY),
                    "# Walkable region for camera height near this floor Y",
                    "# One sample per line: x y z",
                ]
                for p in layer.points {
                    lines.append(String(format: "%.6f %.6f %.6f", p.x, p.y, p.z))
                }
            }
        }

        lines += [
            "",
            "[blocks]",
            "# Solid wall panels. One per line:",
            "# centerX centerZ baseY width depth height yaw_degrees",
            String(
                format: "# defaults width=%.3f depth=%.3f height=%.3f",
                Constants.collisionBlockWidth,
                Constants.collisionBlockDepth,
                Constants.collisionBlockHeight
            ),
        ]
        if collisionBlocks.isEmpty {
            lines.append("# (none)")
        } else {
            for block in collisionBlocks {
                lines.append(
                    String(
                        format: "%.6f %.6f %.6f %.6f %.6f %.6f %.6f",
                        block.centerX,
                        block.centerZ,
                        block.baseY,
                        block.width,
                        block.depth,
                        block.height,
                        block.yawRadians * 180 / .pi
                    )
                )
            }
        }

        if stairPolygons.isEmpty {
            lines += [
                "",
                "[stairs]",
                "# (none)",
            ]
        } else {
            for polygon in stairPolygons {
                lines += [
                    "",
                    "[stairs]",
                    "# Stair polygon vertices in navigation space",
                    "# One vertex per line: x y z",
                ]
                for p in polygon {
                    lines.append(String(format: "%.6f %.6f %.6f", p.x, p.y, p.z))
                }
            }
        }
        lines.append("")
        return lines.joined(separator: "\n")
    }

    private static func parseFloorAttribute(from header: String) -> Float? {
        // [collision floor=1.54] or [collision floor = 1.54]
        guard let range = header.range(of: "floor") else { return nil }
        let after = header[range.upperBound...]
        guard let eq = after.firstIndex(of: "=") else { return nil }
        var value = after[after.index(after: eq)...]
        if let end = value.firstIndex(where: { $0 == "]" || $0.isWhitespace }) {
            value = value[..<end]
        }
        return Float(value.trimmingCharacters(in: .whitespaces))
    }

    // MARK: Codable

    private enum CodingKeys: String, CodingKey {
        case startPosition, startYawRadians, startPitchRadians
        case orientationUp, orientationForward, moveSpeed
        case collisionLayers, collisionBlocks, stairPolygons
        case collisionPoints, stairVertices // legacy
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let start = try c.decode([Float].self, forKey: .startPosition)
        startPosition = SIMD3(start[0], start[1], start[2])
        startYawRadians = try c.decode(Float.self, forKey: .startYawRadians)
        startPitchRadians = try c.decode(Float.self, forKey: .startPitchRadians)

        if let up = try c.decodeIfPresent([Float].self, forKey: .orientationUp), up.count >= 3,
           let forward = try c.decodeIfPresent([Float].self, forKey: .orientationForward), forward.count >= 3 {
            orientationUp = SIMD3(up[0], up[1], up[2])
            orientationForward = SIMD3(forward[0], forward[1], forward[2])
        } else {
            orientationUp = nil
            orientationForward = nil
        }
        moveSpeed = try c.decodeIfPresent(Float.self, forKey: .moveSpeed)

        if let layers = try c.decodeIfPresent([CollisionLayerData].self, forKey: .collisionLayers) {
            collisionLayers = layers
        } else if let flat = try c.decodeIfPresent([[Float]].self, forKey: .collisionPoints) {
            let points = flat.map { SIMD3<Float>($0[0], $0[1], $0[2]) }
            let clusters = WalkableCollisionBounds.clusterByHeight(
                points,
                gap: Constants.collisionFloorClusterGap
            )
            collisionLayers = clusters.map { CollisionLayerData(floorY: $0.floorY, points: $0.points) }
        } else {
            collisionLayers = []
        }

        collisionBlocks = try c.decodeIfPresent([CollisionBlock].self, forKey: .collisionBlocks) ?? []

        if let polys = try c.decodeIfPresent([[[Float]]].self, forKey: .stairPolygons) {
            stairPolygons = polys.map { $0.map { SIMD3($0[0], $0[1], $0[2]) } }.filter { $0.count >= 3 }
        } else if let flat = try c.decodeIfPresent([[Float]].self, forKey: .stairVertices) {
            let poly = flat.map { SIMD3<Float>($0[0], $0[1], $0[2]) }
            stairPolygons = poly.count >= 3 ? [poly] : []
        } else {
            stairPolygons = []
        }
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode([startPosition.x, startPosition.y, startPosition.z], forKey: .startPosition)
        try c.encode(startYawRadians, forKey: .startYawRadians)
        try c.encode(startPitchRadians, forKey: .startPitchRadians)
        if let orientationUp {
            try c.encode([orientationUp.x, orientationUp.y, orientationUp.z], forKey: .orientationUp)
        }
        if let orientationForward {
            try c.encode([orientationForward.x, orientationForward.y, orientationForward.z], forKey: .orientationForward)
        }
        try c.encodeIfPresent(moveSpeed, forKey: .moveSpeed)
        try c.encode(collisionLayers, forKey: .collisionLayers)
        try c.encode(collisionBlocks, forKey: .collisionBlocks)
        try c.encode(stairPolygons.map { $0.map { [$0.x, $0.y, $0.z] } }, forKey: .stairPolygons)
    }
}
