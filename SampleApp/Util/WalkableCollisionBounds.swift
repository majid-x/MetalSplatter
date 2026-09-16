import Foundation
import simd

/// One walkable XZ polygon that only applies near a given floor height.
struct WalkableCollisionLayer {
    /// Representative standing height for this floor (camera Y).
    let floorY: Float
    /// Half-band around `floorY` where this layer is active.
    let halfHeight: Float
    /// Polygon vertices in XZ.
    let vertices: [SIMD2<Float>]

    func containsHeight(_ y: Float) -> Bool {
        abs(y - floorY) <= halfHeight
    }

    func containsXZ(_ point: SIMD2<Float>) -> Bool {
        var inside = false
        var j = vertices.count - 1
        for i in 0..<vertices.count {
            let a = vertices[i]
            let b = vertices[j]
            let intersects = ((a.y > point.y) != (b.y > point.y))
                && (point.x < (b.x - a.x) * (point.y - a.y) / (b.y - a.y + 1e-12) + a.x)
            if intersects {
                inside.toggle()
            }
            j = i
        }
        return inside
    }

    func clampXZ(_ position: SIMD3<Float>) -> SIMD3<Float> {
        let xz = SIMD2(position.x, position.z)
        if containsXZ(xz) {
            return position
        }
        let nearest = nearestPointOnBoundary(to: xz)
        return SIMD3(nearest.x, position.y, nearest.y)
    }

    private func nearestPointOnBoundary(to point: SIMD2<Float>) -> SIMD2<Float> {
        var best = vertices[0]
        var bestDistSq = Float.greatestFiniteMagnitude
        let count = vertices.count
        for i in 0..<count {
            let a = vertices[i]
            let b = vertices[(i + 1) % count]
            let candidate = closestPoint(onSegmentFrom: a, to: b, point: point)
            let delta = candidate - point
            let distSq = simd_dot(delta, delta)
            if distSq < bestDistSq {
                bestDistSq = distSq
                best = candidate
            }
        }
        return best
    }

    private func closestPoint(onSegmentFrom a: SIMD2<Float>, to b: SIMD2<Float>, point: SIMD2<Float>) -> SIMD2<Float> {
        let ab = b - a
        let lengthSq = simd_dot(ab, ab)
        guard lengthSq > 1e-12 else { return a }
        let t = max(0, min(1, simd_dot(point - a, ab) / lengthSq))
        return a + ab * t
    }
}

/// Height-banded walkable regions. Only the layer matching camera Y is applied;
/// between floors (e.g. mid-stairs) collision does not clamp XZ.
struct WalkableCollisionBounds {
    let layers: [WalkableCollisionLayer]

    static var defaultHalfHeight: Float { Constants.collisionFloorHalfHeight }

    /// Build layers by clustering samples by Y, then one polygon per cluster.
    static func fromPoints(
        _ points: [SIMD3<Float>],
        halfHeight: Float = defaultHalfHeight,
        clusterGap: Float = Constants.collisionFloorClusterGap
    ) -> WalkableCollisionBounds? {
        let clusters = clusterByHeight(points, gap: clusterGap)
        return fromClusters(clusters, halfHeight: halfHeight)
    }

    static func fromClusters(
        _ clusters: [(floorY: Float, points: [SIMD3<Float>])],
        halfHeight: Float = defaultHalfHeight
    ) -> WalkableCollisionBounds? {
        var layers: [WalkableCollisionLayer] = []
        layers.reserveCapacity(clusters.count)
        for cluster in clusters {
            let vertices = cluster.points.map { SIMD2($0.x, $0.z) }
            guard vertices.count >= 3 else { continue }
            layers.append(
                WalkableCollisionLayer(
                    floorY: cluster.floorY,
                    halfHeight: halfHeight,
                    vertices: vertices
                )
            )
        }
        guard !layers.isEmpty else { return nil }
        return WalkableCollisionBounds(layers: layers)
    }

    static func parse(_ text: String) -> WalkableCollisionBounds? {
        fromPoints(parsePoints(text))
    }

    static func parsePoints(_ text: String) -> [SIMD3<Float>] {
        var points: [SIMD3<Float>] = []
        points.reserveCapacity(512)
        for line in text.split(whereSeparator: \.isNewline) {
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            if trimmed.isEmpty || trimmed.hasPrefix("#") { continue }
            let parts = trimmed.split(whereSeparator: \.isWhitespace)
            guard parts.count >= 3,
                  let x = Float(parts[0]),
                  let y = Float(parts[1]),
                  let z = Float(parts[2]) else { continue }
            points.append(SIMD3(x, y, z))
        }
        return points
    }

    /// Active layer for this standing height, if any.
    func activeLayer(atHeight y: Float) -> WalkableCollisionLayer? {
        var best: WalkableCollisionLayer?
        var bestDist = Float.greatestFiniteMagnitude
        for layer in layers where layer.containsHeight(y) {
            let dist = abs(y - layer.floorY)
            if dist < bestDist {
                bestDist = dist
                best = layer
            }
        }
        return best
    }

    /// Clamp XZ using only the collision layer for the current height.
    /// If no layer matches (between floors / basement without data), leave XZ free.
    func clamp(_ position: SIMD3<Float>) -> SIMD3<Float> {
        guard let layer = activeLayer(atHeight: position.y) else {
            return position
        }
        return layer.clampXZ(position)
    }

    /// Group points into floors when consecutive Y values jump by more than `gap`.
    static func clusterByHeight(
        _ points: [SIMD3<Float>],
        gap: Float
    ) -> [(floorY: Float, points: [SIMD3<Float>])] {
        guard !points.isEmpty else { return [] }
        let sorted = points.sorted { $0.y < $1.y }
        var clusters: [[SIMD3<Float>]] = []
        var current: [SIMD3<Float>] = []
        var currentY = sorted[0].y

        for p in sorted {
            if current.isEmpty || abs(p.y - currentY) <= gap {
                current.append(p)
                // Keep running mean for robustness.
                let sum = current.reduce(Float(0)) { $0 + $1.y }
                currentY = sum / Float(current.count)
            } else {
                clusters.append(current)
                current = [p]
                currentY = p.y
            }
        }
        if !current.isEmpty {
            clusters.append(current)
        }

        return clusters.map { group in
            let floorY = group.reduce(Float(0)) { $0 + $1.y } / Float(group.count)
            return (floorY, group)
        }
    }
}
