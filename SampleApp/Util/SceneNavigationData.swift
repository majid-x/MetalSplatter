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
    /// Collision layers by floor height. Empty = no walkable clamp.
    var collisionLayers: [CollisionLayerData]
    /// One or more stair polygons (each needs ≥ 3 vertices).
    var stairPolygons: [[SIMD3<Float>]]

    /// Flattened collision points (for export helpers / legacy call sites).
    var collisionPoints: [SIMD3<Float>] {
        collisionLayers.flatMap(\.points)
    }

    /// First stair polygon, or empty — legacy convenience.
    var stairVertices: [SIMD3<Float>] {
        stairPolygons.first ?? []
    }

    static let empty = SceneNavigationData(
        startPosition: SIMD3(0, 0, 1.54),
        startYawRadians: 0,
        startPitchRadians: 0,
        collisionLayers: [],
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
        collisionLayers: [CollisionLayerData],
        stairPolygons: [[SIMD3<Float>]]
    ) {
        self.startPosition = startPosition
        self.startYawRadians = startYawRadians
        self.startPitchRadians = startPitchRadians
        self.collisionLayers = collisionLayers
        self.stairPolygons = stairPolygons
    }

    /// Convenience: auto-cluster a flat collision list; optional single stair polygon.
    init(
        startPosition: SIMD3<Float>,
        startYawRadians: Float,
        startPitchRadians: Float,
        collisionPoints: [SIMD3<Float>],
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
            collisionLayers: clusters.map { CollisionLayerData(floorY: $0.floorY, points: $0.points) },
            stairPolygons: stairVertices.count >= 3 ? [stairVertices] : []
        )
    }

    init(
        startPosition: SIMD3<Float>,
        startYawRadians: Float,
        startPitchRadians: Float,
        collisionPoints: [SIMD3<Float>],
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
            collisionLayers: clusters.map { CollisionLayerData(floorY: $0.floorY, points: $0.points) },
            stairPolygons: stairPolygons.filter { $0.count >= 3 }
        )
    }

    static func parse(_ text: String) throws -> SceneNavigationData {
        enum Section {
            case none, start, collision, stairs
        }

        var section: Section = .none
        var startValues: [Float]?
        var stairPolygons: [[SIMD3<Float>]] = []
        var currentStairPoints: [SIMD3<Float>] = []
        var layers: [CollisionLayerData] = []
        var currentLayerFloor: Float?
        var currentLayerPoints: [SIMD3<Float>] = []


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

            let parts = line.split(whereSeparator: \.isWhitespace).compactMap { Float($0) }
            switch section {
            case .none:
                continue
            case .start:
                guard parts.count >= 3 else { continue }
                startValues = parts
            case .collision:
                guard parts.count >= 3 else { continue }
                currentLayerPoints.append(SIMD3(parts[0], parts[1], parts[2]))
            case .stairs:
                guard parts.count >= 3 else { continue }
                currentStairPoints.append(SIMD3(parts[0], parts[1], parts[2]))
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
        return SceneNavigationData(
            startPosition: SIMD3(startValues[0], startValues[1], startValues[2]),
            startYawRadians: yawDeg * .pi / 180,
            startPitchRadians: pitchDeg * .pi / 180,
            collisionLayers: layers,
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
        case startPosition, startYawRadians, startPitchRadians, collisionLayers, stairPolygons
        case collisionPoints, stairVertices // legacy
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let start = try c.decode([Float].self, forKey: .startPosition)
        startPosition = SIMD3(start[0], start[1], start[2])
        startYawRadians = try c.decode(Float.self, forKey: .startYawRadians)
        startPitchRadians = try c.decode(Float.self, forKey: .startPitchRadians)

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
        try c.encode(collisionLayers, forKey: .collisionLayers)
        try c.encode(stairPolygons.map { $0.map { [$0.x, $0.y, $0.z] } }, forKey: .stairPolygons)
    }
}
