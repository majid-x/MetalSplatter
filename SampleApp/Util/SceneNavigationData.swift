import Foundation
import simd

/// Combined start / collision / stairs navigation for a splat scene.
struct SceneNavigationData: Equatable, Hashable, Codable {
    var startPosition: SIMD3<Float>
    var startYawRadians: Float
    var startPitchRadians: Float
    var collisionPoints: [SIMD3<Float>]
    var stairVertices: [SIMD3<Float>]

    static let empty = SceneNavigationData(
        startPosition: SIMD3(0, 0, 1.54),
        startYawRadians: 0,
        startPitchRadians: 0,
        collisionPoints: [],
        stairVertices: []
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

    static func parse(_ text: String) throws -> SceneNavigationData {
        enum Section {
            case none, start, collision, stairs
        }

        var section: Section = .none
        var startValues: [Float]?
        var collision: [SIMD3<Float>] = []
        var stairs: [SIMD3<Float>] = []

        for rawLine in text.split(whereSeparator: \.isNewline) {
            let line = rawLine.trimmingCharacters(in: .whitespaces)
            if line.isEmpty || line.hasPrefix("#") { continue }

            let lowered = line.lowercased()
            if lowered == "[start]" {
                section = .start
                continue
            }
            if lowered == "[collision]" {
                section = .collision
                continue
            }
            if lowered == "[stairs]" || lowered == "[stair]" {
                section = .stairs
                continue
            }

            let parts = line.split(whereSeparator: \.isWhitespace).compactMap { Float($0) }
            switch section {
            case .none:
                continue
            case .start:
                // x y z [yaw_deg [pitch_deg]]
                guard parts.count >= 3 else { continue }
                startValues = parts
            case .collision, .stairs:
                guard parts.count >= 3 else { continue }
                let point = SIMD3(parts[0], parts[1], parts[2])
                if section == .collision {
                    collision.append(point)
                } else {
                    stairs.append(point)
                }
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
            collisionPoints: collision,
            stairVertices: stairs
        )
    }

    func serialize() -> String {
        var lines: [String] = [
            "# MetalSplatter scene navigation",
            "# version 1",
            "# Put this file in a zip next to your .ply (or .splat / .spz), then open the zip in SampleApp.",
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
            "",
            "[collision]",
            "# World-space camera XYZ samples (walkable region)",
            "# One sample per line: x y z",
        ]
        for p in collisionPoints {
            lines.append(String(format: "%.6f %.6f %.6f", p.x, p.y, p.z))
        }
        lines += [
            "",
            "[stairs]",
            "# Stair polygon vertices in navigation space",
            "# One vertex per line: x y z",
        ]
        for p in stairVertices {
            lines.append(String(format: "%.6f %.6f %.6f", p.x, p.y, p.z))
        }
        lines.append("")
        return lines.joined(separator: "\n")
    }

    // MARK: Codable (SIMD3 is not Codable)

    private enum CodingKeys: String, CodingKey {
        case startPosition, startYawRadians, startPitchRadians, collisionPoints, stairVertices
    }

    init(
        startPosition: SIMD3<Float>,
        startYawRadians: Float,
        startPitchRadians: Float,
        collisionPoints: [SIMD3<Float>],
        stairVertices: [SIMD3<Float>]
    ) {
        self.startPosition = startPosition
        self.startYawRadians = startYawRadians
        self.startPitchRadians = startPitchRadians
        self.collisionPoints = collisionPoints
        self.stairVertices = stairVertices
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let start = try c.decode([Float].self, forKey: .startPosition)
        startPosition = SIMD3(start[0], start[1], start[2])
        startYawRadians = try c.decode(Float.self, forKey: .startYawRadians)
        startPitchRadians = try c.decode(Float.self, forKey: .startPitchRadians)
        collisionPoints = try c.decode([[Float]].self, forKey: .collisionPoints).map { SIMD3($0[0], $0[1], $0[2]) }
        stairVertices = try c.decode([[Float]].self, forKey: .stairVertices).map { SIMD3($0[0], $0[1], $0[2]) }
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode([startPosition.x, startPosition.y, startPosition.z], forKey: .startPosition)
        try c.encode(startYawRadians, forKey: .startYawRadians)
        try c.encode(startPitchRadians, forKey: .startPitchRadians)
        try c.encode(collisionPoints.map { [$0.x, $0.y, $0.z] }, forKey: .collisionPoints)
        try c.encode(stairVertices.map { [$0.x, $0.y, $0.z] }, forKey: .stairVertices)
    }
}