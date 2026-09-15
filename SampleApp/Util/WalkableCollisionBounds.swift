#if os(iOS) || os(macOS)

import Foundation
import simd

/// Closed XZ walkable region built from a recorded camera path.
struct WalkableCollisionBounds {
    /// Polygon vertices in XZ (y of camera is ignored for containment).
    let vertices: [SIMD2<Float>]

    static func fromPoints(_ points: [SIMD3<Float>]) -> WalkableCollisionBounds? {
        let vertices = points.map { SIMD2($0.x, $0.z) }
        guard vertices.count >= 3 else { return nil }
        return WalkableCollisionBounds(vertices: vertices)
    }

    static func parse(_ text: String) -> WalkableCollisionBounds? {
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
        return fromPoints(points)
    }

    func contains(_ position: SIMD3<Float>) -> Bool {
        contains(SIMD2(position.x, position.z))
    }

    /// Keep XZ inside the polygon; leave Y unchanged. Outside points snap to the nearest boundary.
    func clamp(_ position: SIMD3<Float>) -> SIMD3<Float> {
        let xz = SIMD2(position.x, position.z)
        if contains(xz) {
            return position
        }
        let nearest = nearestPointOnBoundary(to: xz)
        return SIMD3(nearest.x, position.y, nearest.y)
    }

    private func contains(_ point: SIMD2<Float>) -> Bool {
        // Ray casting along +X.
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

#endif
