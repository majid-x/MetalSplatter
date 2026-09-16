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
