import Foundation
import simd

/// Solid wall panel in navigation space (thin depth, wider face).
struct CollisionBlock: Equatable, Hashable, Codable {
    /// Center of the wall footprint in XZ.
    var centerX: Float
    var centerZ: Float
    /// Bottom of the wall.
    var baseY: Float
    /// Length along the wall face (local X).
    var width: Float
    /// Thickness of the wall (local Z) — thin like a real wall.
    var depth: Float
    /// Vertical size.
    var height: Float
    /// Yaw around up-axis (radians). Local +X is along the wall face.
    var yawRadians: Float

    var center: SIMD3<Float> {
        SIMD3(centerX, baseY + height * 0.5, centerZ)
    }

    static var defaultWidth: Float { Constants.collisionBlockWidth }
    static var defaultDepth: Float { Constants.collisionBlockDepth }
    static var defaultHeight: Float { Constants.collisionBlockHeight }

    init(
        centerX: Float,
        centerZ: Float,
        baseY: Float,
        width: Float = CollisionBlock.defaultWidth,
        depth: Float = CollisionBlock.defaultDepth,
        height: Float = CollisionBlock.defaultHeight,
        yawRadians: Float = 0
    ) {
        self.centerX = centerX
        self.centerZ = centerZ
        self.baseY = baseY
        self.width = max(Constants.collisionBlockMinWidth, width)
        self.depth = max(0.05, depth)
        self.height = max(Constants.collisionBlockMinHeight, height)
        self.yawRadians = yawRadians
    }

    /// Bottom-centered on a free 3D cursor hit.
    init(bottomCenter point: SIMD3<Float>, yawRadians: Float) {
        self.init(
            centerX: point.x,
            centerZ: point.z,
            baseY: point.y,
            yawRadians: yawRadians
        )
    }

    func overlapsHeight(_ y: Float, radius: Float = 0) -> Bool {
        y >= baseY - radius && y <= baseY + height + radius
    }

    /// Camera walks at standing height; treat a short vertical band around it as the body.
    func overlapsPlayer(at y: Float, radius: Float = 0) -> Bool {
        let playerMin = y - 0.25
        let playerMax = y + 1.55
        let wallMin = baseY - radius
        let wallMax = baseY + height + radius
        return wallMin <= playerMax && wallMax >= playerMin
    }

    /// True when the point's XZ is inside the wall footprint (expanded by radius).
    func penetratesXZ(_ point: SIMD3<Float>, radius: Float) -> Bool {
        guard overlapsPlayer(at: point.y, radius: radius) else { return false }
        let local = toLocalXZ(point)
        let halfW = width * 0.5 + radius
        let halfD = depth * 0.5 + radius
        return abs(local.x) < halfW && abs(local.y) < halfD
    }

    /// Rotate a local XZ offset (local.x along wall, local.y through thickness) into world XZ.
    /// Matches R_y(yaw) * (x, 0, z).
    func fromLocalXZ(_ local: SIMD2<Float>) -> SIMD2<Float> {
        let c = cos(yawRadians)
        let s = sin(yawRadians)
        return SIMD2(local.x * c + local.y * s, -local.x * s + local.y * c)
    }

    /// Inverse of `fromLocalXZ`.
    func toLocalXZ(_ point: SIMD3<Float>) -> SIMD2<Float> {
        let dx = point.x - centerX
        let dz = point.z - centerZ
        let c = cos(yawRadians)
        let s = sin(yawRadians)
        // R_y(-yaw)
        return SIMD2(dx * c - dz * s, dx * s + dz * c)
    }

    func contains(_ point: SIMD3<Float>, padding: Float = 0.08) -> Bool {
        guard overlapsHeight(point.y, radius: padding) else { return false }
        let local = toLocalXZ(point)
        return abs(local.x) <= width * 0.5 + padding
            && abs(local.y) <= depth * 0.5 + padding
    }

    /// Free placement at the cursor. Snaps flush to a neighbor face when close.
    static func placement(
        at point: SIMD3<Float>,
        yawRadians: Float,
        existing: [CollisionBlock]
    ) -> CollisionBlock {
        let snap = Constants.collisionBlockSnapDistance
        let raw = SIMD2(point.x, point.z)

        var bestCenter: SIMD2<Float>?
        var bestBaseY = point.y
        var bestYaw = yawRadians
        var bestWidth = defaultWidth
        var bestDepth = defaultDepth
        var bestHeight = defaultHeight
        var bestDist = Float.greatestFiniteMagnitude

        for block in existing {
            let locals: [SIMD2<Float>] = [
                SIMD2(block.width, 0),
                SIMD2(-block.width, 0),
                SIMD2(0, block.depth),
                SIMD2(0, -block.depth),
            ]
            for local in locals {
                let world = block.fromLocalXZ(local)
                let c = SIMD2(block.centerX + world.x, block.centerZ + world.y)
                let verticalPenalty = abs(block.baseY - point.y)
                let d = simd_length(c - raw) + verticalPenalty * 0.25
                if d < bestDist {
                    bestDist = d
                    bestCenter = c
                    bestBaseY = block.baseY
                    bestYaw = block.yawRadians
                    bestWidth = block.width
                    bestDepth = block.depth
                    bestHeight = block.height
                }
            }
        }

        if let bestCenter, bestDist <= snap {
            let block = CollisionBlock(
                centerX: bestCenter.x,
                centerZ: bestCenter.y,
                baseY: bestBaseY,
                width: bestWidth,
                depth: bestDepth,
                height: bestHeight,
                yawRadians: bestYaw
            )
            if !existing.contains(where: { $0.isSameCell(as: block) }) {
                return block
            }
        }

        return CollisionBlock(bottomCenter: point, yawRadians: yawRadians)
    }

    func isSameCell(as other: CollisionBlock) -> Bool {
        abs(centerX - other.centerX) < 1e-3
            && abs(centerZ - other.centerZ) < 1e-3
            && abs(baseY - other.baseY) < 1e-3
            && abs(yawRadians - other.yawRadians) < 1e-3
    }

    /// Slide move: never teleport through a wall. Axis-separate so you can strafe along faces.
    static func move(
        from start: SIMD3<Float>,
        to end: SIMD3<Float>,
        against blocks: [CollisionBlock],
        radius: Float = Constants.collisionBlockPlayerRadius
    ) -> SIMD3<Float> {
        guard !blocks.isEmpty else { return end }

        var p = start
        // Only depenetrate if already stuck inside before this step.
        if penetrates(p, blocks: blocks, radius: radius) {
            let travel = end - start
            p = depenetrate(p, preferredToward: -travel, blocks: blocks, radius: radius)
            if penetrates(p, blocks: blocks, radius: radius) {
                return start
            }
        }

        let xProbe = SIMD3(end.x, p.y, p.z)
        if !penetrates(xProbe, blocks: blocks, radius: radius) {
            p.x = end.x
        }

        let zProbe = SIMD3(p.x, p.y, end.z)
        if !penetrates(zProbe, blocks: blocks, radius: radius) {
            p.z = end.z
        }

        return p
    }

    private static func penetrates(
        _ point: SIMD3<Float>,
        blocks: [CollisionBlock],
        radius: Float
    ) -> Bool {
        blocks.contains { $0.penetratesXZ(point, radius: radius) }
    }

    /// Push out of overlapping walls. Bias toward the side we came from so holding
    /// forward into a wall never ejects you out the back.
    private static func depenetrate(
        _ position: SIMD3<Float>,
        preferredToward bias: SIMD3<Float>,
        blocks: [CollisionBlock],
        radius: Float
    ) -> SIMD3<Float> {
        var p = position
        for _ in 0..<4 {
            for block in blocks where block.penetratesXZ(p, radius: radius) {
                var local = block.toLocalXZ(p)
                let halfW = block.width * 0.5 + radius
                let halfD = block.depth * 0.5 + radius

                let left = local.x + halfW
                let right = halfW - local.x
                let near = local.y + halfD
                let far = halfD - local.y

                let biasLocal = block.toLocalXZ(SIMD3(p.x + bias.x, p.y, p.z + bias.z)) - local
                // Outward normals: -X, +X, -Z, +Z — prefer faces matching where we came from.
                let faces: [(Float, Int)] = [
                    (biasLocal.x < 0 ? left * 0.2 : left, 0),
                    (biasLocal.x > 0 ? right * 0.2 : right, 1),
                    (biasLocal.y < 0 ? near * 0.2 : near, 2),
                    (biasLocal.y > 0 ? far * 0.2 : far, 3),
                ]
                guard let best = faces.min(by: { $0.0 < $1.0 }) else { continue }
                switch best.1 {
                case 0: local.x = -halfW
                case 1: local.x = halfW
                case 2: local.y = -halfD
                default: local.y = halfD
                }
                let world = block.fromLocalXZ(local)
                p.x = block.centerX + world.x
                p.z = block.centerZ + world.y
            }
        }
        return p
    }

    /// Keep call sites working; prefer `move(from:to:against:)` for gameplay.
    static func resolve(
        _ position: SIMD3<Float>,
        against blocks: [CollisionBlock],
        radius: Float = Constants.collisionBlockPlayerRadius
    ) -> SIMD3<Float> {
        if penetrates(position, blocks: blocks, radius: radius) {
            return depenetrate(position, preferredToward: .zero, blocks: blocks, radius: radius)
        }
        return position
    }

    /// Ray vs OBB pick (walls are depth-less overlays, so depth-buffer picks miss them).
    static func hitTestRay(
        origin: SIMD3<Float>,
        direction: SIMD3<Float>,
        in blocks: [CollisionBlock],
        maxDistance: Float = 80
    ) -> Int? {
        let dirLen = simd_length(direction)
        guard dirLen > 1e-6 else { return nil }
        let dir = direction / dirLen

        var bestIndex: Int?
        var bestT = maxDistance

        for (index, block) in blocks.enumerated() {
            if let t = block.rayIntersection(origin: origin, direction: dir), t < bestT, t >= 0 {
                bestT = t
                bestIndex = index
            }
        }
        return bestIndex
    }

    /// Intersect a unit direction ray with this wall's OBB (with a little pick padding).
    func rayIntersection(origin: SIMD3<Float>, direction: SIMD3<Float>) -> Float? {
        let pad: Float = 0.15
        let halfW = width * 0.5 + pad
        let halfD = depth * 0.5 + pad
        let minY = baseY - pad
        let maxY = baseY + height + pad

        // Transform ray into block-local space (Y unchanged).
        let localOriginXZ = toLocalXZ(origin)
        let localOrigin = SIMD3(localOriginXZ.x, origin.y, localOriginXZ.y)

        // Direction: rotate XZ by -yaw; Y stays.
        let c = cos(yawRadians)
        let s = sin(yawRadians)
        let localDir = SIMD3(
            direction.x * c - direction.z * s,
            direction.y,
            direction.x * s + direction.z * c
        )

        let minB = SIMD3(-halfW, minY, -halfD)
        let maxB = SIMD3(halfW, maxY, halfD)

        var tMin: Float = 0
        var tMax: Float = .greatestFiniteMagnitude

        for axis in 0..<3 {
            let o: Float
            let d: Float
            let mn: Float
            let mx: Float
            switch axis {
            case 0:
                o = localOrigin.x; d = localDir.x; mn = minB.x; mx = maxB.x
            case 1:
                o = localOrigin.y; d = localDir.y; mn = minB.y; mx = maxB.y
            default:
                o = localOrigin.z; d = localDir.z; mn = minB.z; mx = maxB.z
            }
            if abs(d) < 1e-8 {
                if o < mn || o > mx { return nil }
                continue
            }
            var t1 = (mn - o) / d
            var t2 = (mx - o) / d
            if t1 > t2 { swap(&t1, &t2) }
            tMin = max(tMin, t1)
            tMax = min(tMax, t2)
            if tMin > tMax { return nil }
        }
        if tMax < 0 { return nil }
        return tMin >= 0 ? tMin : tMax
    }
}
