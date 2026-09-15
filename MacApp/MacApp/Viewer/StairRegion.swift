#if os(iOS) || os(macOS)

import Foundation
import simd

/// PLY/model space ↔ FPS camera navigation space.
/// MetalSplatter's view matrix applies a 180° Z rotation to the model; camera
/// movement and collision live in that post-rotation (display) frame, while
/// depth unprojection returns pre-rotation model coordinates.
enum SplatNavigationSpace {
    static func fromModel(_ point: SIMD3<Float>) -> SIMD3<Float> {
        SIMD3(-point.x, -point.y, point.z)
    }

    static func toModel(_ point: SIMD3<Float>) -> SIMD3<Float> {
        SIMD3(-point.x, -point.y, point.z)
    }
}

/// Closed XZ polygon with per-vertex heights (navigation / camera space).
/// Raw pick heights are remapped so the low end = ground and the high end = ground + rise.
struct StairRegion {
    /// Polygon vertices in navigation space (Y is stair height at that corner).
    let vertices: [SIMD3<Float>]
    /// Plane: heightY = ax + cz + d (raw pick / surface space)
    private let planeA: Float
    private let planeC: Float
    private let planeD: Float
    /// Lowest / highest raw vertex Y on the marked stair.
    private let rawMinY: Float
    private let rawMaxY: Float
    /// Extra margin so walking near an edge still counts as on the stair.
    private let edgePadding: Float

    /// Camera Y at the bottom of the stairs (normal ground).
    var lowerFloorY: Float { Constants.cameraGroundY }
    /// Camera Y at the top of the stairs (ground + measured rise).
    var upperFloorY: Float { Constants.cameraGroundY + max(0, rawMaxY - rawMinY) }

    static func parse(_ text: String, edgePadding: Float = Constants.stairEdgePadding) -> StairRegion? {
        var vertices: [SIMD3<Float>] = []
        vertices.reserveCapacity(8)
        for line in text.split(whereSeparator: \.isNewline) {
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            if trimmed.isEmpty || trimmed.hasPrefix("#") { continue }
            let parts = trimmed.split(whereSeparator: \.isWhitespace)
            guard parts.count >= 3,
                  let x = Float(parts[0]),
                  let y = Float(parts[1]),
                  let z = Float(parts[2]) else { continue }
            vertices.append(SIMD3(x, y, z))
        }
        return make(vertices: vertices, edgePadding: edgePadding)
    }

    static func make(
        vertices: [SIMD3<Float>],
        edgePadding: Float = Constants.stairEdgePadding
    ) -> StairRegion? {
        guard vertices.count >= 3 else { return nil }
        guard let plane = fitPlane(vertices: vertices) else { return nil }
        let ys = vertices.map(\.y)
        guard let rawMinY = ys.min(), let rawMaxY = ys.max() else { return nil }
        return StairRegion(
            vertices: vertices,
            planeA: plane.a,
            planeC: plane.c,
            planeD: plane.d,
            rawMinY: rawMinY,
            rawMaxY: rawMaxY,
            edgePadding: edgePadding
        )
    }

    func contains(_ position: SIMD3<Float>) -> Bool {
        let xz = SIMD2(position.x, position.z)
        if contains(xz) { return true }
        if edgePadding <= 0 { return false }
        return distanceToBoundary(xz) <= edgePadding
    }

    /// Remapped walking height: bottom → normal ground, top → normal upper floor.
    func navigationHeight(at position: SIMD3<Float>) -> Float? {
        guard contains(position) else { return nil }
        let raw = planeA * position.x + planeC * position.z + planeD
        let rise = rawMaxY - rawMinY
        guard rise > 1e-4 else { return lowerFloorY }
        let t = max(0, min(1, (raw - rawMinY) / rise))
        return lowerFloorY + t * (upperFloorY - lowerFloorY)
    }

    /// Snap an off-stair standing height to the nearer floor level.
    func nearestFloorY(to height: Float) -> Float {
        let mid = 0.5 * (lowerFloorY + upperFloorY)
        return height >= mid ? upperFloorY : lowerFloorY
    }

    private func contains(_ point: SIMD2<Float>) -> Bool {
        var inside = false
        var j = vertices.count - 1
        for i in 0..<vertices.count {
            let a = SIMD2(vertices[i].x, vertices[i].z)
            let b = SIMD2(vertices[j].x, vertices[j].z)
            let intersects = ((a.y > point.y) != (b.y > point.y))
                && (point.x < (b.x - a.x) * (point.y - a.y) / (b.y - a.y + 1e-12) + a.x)
            if intersects {
                inside.toggle()
            }
            j = i
        }
        return inside
    }

    private func distanceToBoundary(_ point: SIMD2<Float>) -> Float {
        var best = Float.greatestFiniteMagnitude
        let count = vertices.count
        for i in 0..<count {
            let a = SIMD2(vertices[i].x, vertices[i].z)
            let b = SIMD2(vertices[(i + 1) % count].x, vertices[(i + 1) % count].z)
            let ab = b - a
            let lengthSq = simd_dot(ab, ab)
            let t: Float
            if lengthSq < 1e-12 {
                t = 0
            } else {
                t = max(0, min(1, simd_dot(point - a, ab) / lengthSq))
            }
            let closest = a + ab * t
            best = min(best, simd_length(point - closest))
        }
        return best
    }

    /// Least-squares plane y = a*x + c*z + d through the vertices.
    private static func fitPlane(vertices: [SIMD3<Float>]) -> (a: Float, c: Float, d: Float)? {
        var sxx: Float = 0, sxz: Float = 0, sx: Float = 0
        var szz: Float = 0, sz: Float = 0
        var sxy: Float = 0, szy: Float = 0, sy: Float = 0
        let n = Float(vertices.count)

        for v in vertices {
            sxx += v.x * v.x
            sxz += v.x * v.z
            sx += v.x
            szz += v.z * v.z
            sz += v.z
            sxy += v.x * v.y
            szy += v.z * v.y
            sy += v.y
        }

        let m00 = sxx, m01 = sxz, m02 = sx
        let m10 = sxz, m11 = szz, m12 = sz
        let m20 = sx,  m21 = sz,  m22 = n

        let det =
            m00 * (m11 * m22 - m12 * m21)
            - m01 * (m10 * m22 - m12 * m20)
            + m02 * (m10 * m21 - m11 * m20)
        guard abs(det) > 1e-8 else {
            return (0, 0, sy / n)
        }

        let invDet = 1 / det
        let a =
            invDet * (
                sxy * (m11 * m22 - m12 * m21)
                - m01 * (szy * m22 - m12 * sy)
                + m02 * (szy * m21 - m11 * sy)
            )
        let c =
            invDet * (
                m00 * (szy * m22 - m12 * sy)
                - sxy * (m10 * m22 - m12 * m20)
                + m02 * (m10 * sy - szy * m20)
            )
        let d =
            invDet * (
                m00 * (m11 * sy - szy * m21)
                - m01 * (m10 * sy - szy * m20)
                + sxy * (m10 * m21 - m11 * m20)
            )
        return (a, c, d)
    }
}

#endif
