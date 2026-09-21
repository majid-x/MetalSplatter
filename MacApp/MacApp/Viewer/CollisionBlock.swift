import Foundation
import simd

/// Orthonormal FPS frame: block storage and collision live in this space
/// (`x` along right, `y` along up, `z` along −forward). Matches world axes
/// when orientation is the default Y-up / −Z-forward.
struct NavigationBasis: Equatable {
    var up: SIMD3<Float>
    var forward: SIMD3<Float>
    var right: SIMD3<Float>

    static let yUp = NavigationBasis(
        up: SIMD3(0, 1, 0),
        forward: SIMD3(0, 0, -1),
        right: SIMD3(1, 0, 0)
    )

    init(up: SIMD3<Float>, forward: SIMD3<Float>) {
        let upLen = simd_length(up)
        let upN = upLen > 1e-5 ? up / upLen : SIMD3(0, 1, 0)
        var fwd = forward - simd_dot(forward, upN) * upN
        let fwdLen = simd_length(fwd)
        if fwdLen > 1e-5 {
            fwd /= fwdLen
        } else {
            fwd = abs(upN.y) < 0.9 ? SIMD3(0, 0, -1) : SIMD3(0, -1, 0)
            fwd = simd_normalize(fwd - simd_dot(fwd, upN) * upN)
        }
        let crossed = simd_cross(fwd, upN)
        let rightLen = simd_length(crossed)
        let rightN = rightLen > 1e-5
            ? crossed / rightLen
            : simd_normalize(simd_cross(fwd, abs(upN.x) < 0.9 ? SIMD3(1, 0, 0) : SIMD3(0, 0, 1)))
        self.up = upN
        self.forward = fwd
        self.right = rightN
    }

    init(up: SIMD3<Float>, forward: SIMD3<Float>, right: SIMD3<Float>) {
        self.up = up
        self.forward = forward
        self.right = right
    }

    /// World → block storage (right, up, −forward).
    func toLocal(_ point: SIMD3<Float>) -> SIMD3<Float> {
        SIMD3(
            simd_dot(point, right),
            simd_dot(point, up),
            simd_dot(point, -forward)
        )
    }

    /// Block storage → world.
    func toWorld(_ local: SIMD3<Float>) -> SIMD3<Float> {
        local.x * right + local.y * up + local.z * (-forward)
    }

    /// Maps block-local axes (X right, Y up, Z −forward) into world columns.
    var worldFromLocalMatrix: matrix_float4x4 {
        matrix_float4x4(columns: (
            SIMD4(right.x, right.y, right.z, 0),
            SIMD4(up.x, up.y, up.z, 0),
            SIMD4(-forward.x, -forward.y, -forward.z, 0),
            SIMD4(0, 0, 0, 1)
        ))
    }

    /// Yaw so the wall face (thickness along local Z) points along the look direction.
    func facingYaw(cameraForward: SIMD3<Float>) -> Float {
        var flat = cameraForward - simd_dot(cameraForward, up) * up
        let len = simd_length(flat)
        guard len > 1e-5 else { return 0 }
        flat /= len
        return atan2(simd_dot(flat, right), simd_dot(flat, -forward))
    }
}

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
        self.width = min(Constants.collisionBlockMaxWidth, max(Constants.collisionBlockMinWidth, width))
        self.depth = min(Constants.collisionBlockMaxDepth, max(Constants.collisionBlockMinDepth, depth))
        self.height = min(Constants.collisionBlockMaxHeight, max(Constants.collisionBlockMinHeight, height))
        self.yawRadians = yawRadians
    }

    /// Bottom-centered on a free 3D cursor hit.
    init(
        bottomCenter point: SIMD3<Float>,
        yawRadians: Float,
        width: Float = CollisionBlock.defaultWidth,
        depth: Float = CollisionBlock.defaultDepth,
        height: Float = CollisionBlock.defaultHeight
    ) {
        self.init(
            centerX: point.x,
            centerZ: point.z,
            baseY: point.y,
            width: width,
            depth: depth,
            height: height,
            yawRadians: yawRadians
        )
    }

    /// Thin impassable barrier(s) from 3–4 surface clicks (nav / world space).
    /// Vertical faces → one thin wall sized to the points. Floor-like loops → thin
    /// walls along each edge (encloses the area without a filled cube).
    static func fromClickPoints(
        worldPoints: [SIMD3<Float>],
        basis: NavigationBasis
    ) -> [CollisionBlock] {
        guard (3...4).contains(worldPoints.count) else { return [] }
        let pts = worldPoints.map { basis.toLocal($0) }

        // Newell normal of the click loop.
        var normal = SIMD3<Float>.zero
        for i in 0..<pts.count {
            let cur = pts[i]
            let nxt = pts[(i + 1) % pts.count]
            normal.x += (cur.y - nxt.y) * (cur.z + nxt.z)
            normal.y += (cur.z - nxt.z) * (cur.x + nxt.x)
            normal.z += (cur.x - nxt.x) * (cur.y + nxt.y)
        }
        let nLen = simd_length(normal)
        guard nLen > 1e-8 else { return [] }
        normal /= nLen

        let up = SIMD3<Float>(0, 1, 0)
        // Floor / table top → edge ribbons. Wall / door face → single thin panel.
        if abs(simd_dot(normal, up)) > 0.7 {
            return thinEdgeWalls(fromLocalPoints: pts)
        }
        if let wall = thinFaceWall(fromLocalPoints: pts, preferredNormal: normal) {
            return [wall]
        }
        return []
    }

    /// One thin wall whose face matches the clicked points (width × height from points only).
    private static func thinFaceWall(
        fromLocalPoints pts: [SIMD3<Float>],
        preferredNormal: SIMD3<Float>
    ) -> CollisionBlock? {
        let up = SIMD3<Float>(0, 1, 0)
        var normal = preferredNormal
        // Keep wall upright: drop normal's vertical component when possible.
        var flat = normal - simd_dot(normal, up) * up
        let flatLen = simd_length(flat)
        if flatLen > 1e-5 {
            normal = flat / flatLen
        }

        var widthDir = simd_cross(up, normal)
        let wLen = simd_length(widthDir)
        if wLen < 1e-5 {
            // Degenerate — fall back to longest horizontal edge.
            var best = SIMD3<Float>(1, 0, 0)
            var bestLen: Float = 0
            for i in 0..<pts.count {
                let edge = pts[(i + 1) % pts.count] - pts[i]
                let horiz = SIMD3(edge.x, 0, edge.z)
                let len = simd_length(horiz)
                if len > bestLen {
                    bestLen = len
                    best = horiz / max(len, 1e-6)
                }
            }
            widthDir = best
            normal = simd_normalize(simd_cross(widthDir, up))
        } else {
            widthDir /= wLen
        }

        var minW: Float = .greatestFiniteMagnitude
        var maxW: Float = -.greatestFiniteMagnitude
        var minH: Float = .greatestFiniteMagnitude
        var maxH: Float = -.greatestFiniteMagnitude
        for p in pts {
            let w = simd_dot(p, widthDir)
            let h = simd_dot(p, up)
            minW = min(minW, w); maxW = max(maxW, w)
            minH = min(minH, h); maxH = max(maxH, h)
        }
        let width = max(maxW - minW, Constants.collisionBlockMinWidth)
        let height = max(maxH - minH, Constants.collisionBlockMinHeight)
        let thickness = Constants.collisionBlockThickness(forFaceSize: max(width, height))
        let midW = 0.5 * (minW + maxW)
        let midH = 0.5 * (minH + maxH)
        // Center sits on the face; thin axis along `normal`.
        let avgAlongNormal = pts.map { simd_dot($0, normal) }.reduce(0, +) / Float(pts.count)
        let center = widthDir * midW + up * midH + normal * avgAlongNormal
        let yaw = atan2(-widthDir.z, widthDir.x)

        return CollisionBlock(
            centerX: center.x,
            centerZ: center.z,
            baseY: midH - height * 0.5,
            width: width,
            depth: thickness,
            height: height,
            yawRadians: yaw
        )
    }

    /// Thin upright walls along each edge of a floor-like click loop.
    private static func thinEdgeWalls(fromLocalPoints pts: [SIMD3<Float>]) -> [CollisionBlock] {
        var walls: [CollisionBlock] = []
        let count = pts.count
        var edgeLens: [Float] = []
        for i in 0..<count {
            let a = pts[i]
            let b = pts[(i + 1) % count]
            edgeLens.append(hypot(b.x - a.x, b.z - a.z))
        }
        let avgEdge = edgeLens.reduce(0, +) / Float(max(edgeLens.count, 1))
        // Short barrier — only tall enough to catch the player, not a room-height cube.
        let barrierHeight = min(
            Constants.collisionBlockMaxHeight,
            max(0.12, min(Constants.collisionBlockHeight, avgEdge * 0.9))
        )

        for i in 0..<count {
            let a = pts[i]
            let b = pts[(i + 1) % count]
            let dx = b.x - a.x
            let dz = b.z - a.z
            let len = hypot(dx, dz)
            guard len > Constants.collisionBlockMinWidth else { continue }
            let yaw = atan2(-dz, dx) // width along the edge
            let thickness = Constants.collisionBlockThickness(forFaceSize: len)
            let baseY = min(a.y, b.y)
            walls.append(
                CollisionBlock(
                    centerX: 0.5 * (a.x + b.x),
                    centerZ: 0.5 * (a.z + b.z),
                    baseY: baseY,
                    width: len,
                    depth: thickness,
                    height: barrierHeight,
                    yawRadians: yaw
                )
            )
        }
        return walls
    }

    func overlapsHeight(_ y: Float, radius: Float = 0) -> Bool {
        y >= baseY - radius && y <= baseY + height + radius
    }

    /// Camera walks at standing height; treat a short vertical band around it as the body.
    func overlapsPlayer(at y: Float, radius: Float = 0) -> Bool {
        // Tight band so small-scale splats don't treat every wall as infinitely tall.
        let playerMin = y - 0.15
        let playerMax = y + 0.35
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
        existing: [CollisionBlock],
        width: Float = CollisionBlock.defaultWidth,
        depth: Float = CollisionBlock.defaultDepth,
        height: Float = CollisionBlock.defaultHeight
    ) -> CollisionBlock {
        let snap = Constants.collisionBlockSnapDistance
        let raw = SIMD2(point.x, point.z)

        var bestCenter: SIMD2<Float>?
        var bestBaseY = point.y
        var bestYaw = yawRadians
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
                }
            }
        }

        if let bestCenter, bestDist <= snap {
            let block = CollisionBlock(
                centerX: bestCenter.x,
                centerZ: bestCenter.y,
                baseY: bestBaseY,
                width: width,
                depth: depth,
                height: height,
                yawRadians: bestYaw
            )
            if !existing.contains(where: { $0.isSameCell(as: block) }) {
                return block
            }
        }

        return CollisionBlock(
            bottomCenter: point,
            yawRadians: yawRadians,
            width: width,
            depth: depth,
            height: height
        )
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
