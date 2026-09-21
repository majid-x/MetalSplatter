import Foundation
import SwiftUI

enum Constants {
    static let maxSimultaneousRenders = 3
#if !os(visionOS)
    static let fovy = Angle(degrees: 65)
    /// Starting camera distance in front of the scene origin (looking down -Z).
    static let cameraStartZ: Float = 1.54
    /// Units per second for WASD / arrow / on-screen move controls.
    static let cameraMoveSpeed: Float = 3.5
    /// Radians of look rotation per pixel of mouse / finger movement.
    static let cameraLookSensitivity: Float = 0.005
    /// Max look-up / look-down angle from horizontal, in radians (~89°).
    static let cameraPitchLimit: Float = .pi / 2 - 0.01
    /// Min distance between recorded walk samples while generating collision.
    static let collisionSampleSpacing: Float = 0.05
    /// Default wall face length (local X), in meters.
    static let collisionBlockWidth: Float = 1.6
    /// Default wall thickness (local Z) — thin like a normal wall (~12 cm).
    static let collisionBlockDepth: Float = 0.12
    /// Depth is always this fraction of face size (capped by `collisionBlockDepth`) so walls never look like cubes.
    static let collisionBlockDepthFraction: Float = 0.06
    /// Default wall height ≈ standing character / eye height.
    static let collisionBlockHeight: Float = 1.7

    /// Thin wall depth for a given face size (width/height).
    static func collisionBlockThickness(forFaceSize size: Float) -> Float {
        let face = max(collisionBlockMinWidth, size)
        let proportional = face * collisionBlockDepthFraction
        return min(collisionBlockDepth, max(collisionBlockMinDepth, proportional))
    }
    static let collisionBlockMinWidth: Float = 0.001
    static let collisionBlockMaxWidth: Float = 8.0
    static let collisionBlockMinDepth: Float = 0.001
    static let collisionBlockMinHeight: Float = 0.001
    static let collisionBlockMaxHeight: Float = 4.0
    static let collisionBlockMaxDepth: Float = 4.0
    /// How close a click must be to an existing wall face to snap / auto-connect.
    static let collisionBlockSnapDistance: Float = 0.45
    /// Camera collision radius against solid blocks.
    /// Kept small: splat scenes are often sub‑meter; 0.22 was fattening thin walls into near-cubes.
    static let collisionBlockPlayerRadius: Float = 0.04
    /// Mouse pixels → meters while resizing a selected wall.
    static let collisionBlockResizeSensitivity: Float = 0.012
    /// Vertical climb/descend speed (Q/E) while marking stair vertices.
    static let stairRecordClimbSpeed: Float = 1.5
    /// How far outside the stair polygon still counts as on-stairs.
    static let stairEdgePadding: Float = 0.15
    /// Default floor height when not on a stair region.
    static let cameraGroundY: Float = 0
#endif
    /// Half-band (meters) around a collision layer's floor Y where that layer applies.
    static let collisionFloorHalfHeight: Float = 0.45
    /// Cluster gap (meters) when splitting recorded collision samples into floors.
    static let collisionFloorClusterGap: Float = 0.45
    /// Scene placement offset used on visionOS (head tracking provides viewpoint).
    static let modelCenterZ: Float = -8

    // Procedural splat geometry
    static let proceduralCubeSize: Float = 1.0
    static let proceduralCubeDistance: Float = 1.0
    static let proceduralCubeGridSizes: [Int] = [10, 20, 50]
    static let proceduralCubeSplatRelativeRadius: Float = 0.1
    static let proceduralCubeSwapDelay: TimeInterval = 2.0
}
