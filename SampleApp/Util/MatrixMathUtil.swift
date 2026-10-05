import simd

// Generic matrix math utility functions; from Apple sample code

func matrix4x4_rotation(radians: Float, axis: SIMD3<Float>) -> matrix_float4x4 {
    let unitAxis = normalize(axis)
    let ct = cosf(radians)
    let st = sinf(radians)
    let ci = 1 - ct
    let x = unitAxis.x, y = unitAxis.y, z = unitAxis.z
    return matrix_float4x4.init(columns:(vector_float4(    ct + x * x * ci, y * x * ci + z * st, z * x * ci - y * st, 0),
                                         vector_float4(x * y * ci - z * st,     ct + y * y * ci, z * y * ci + x * st, 0),
                                         vector_float4(x * z * ci + y * st, y * z * ci - x * st,     ct + z * z * ci, 0),
                                         vector_float4(                  0,                   0,                   0, 1)))
}

func matrix4x4_translation(_ translationX: Float, _ translationY: Float, _ translationZ: Float) -> matrix_float4x4 {
    return matrix_float4x4.init(columns:(vector_float4(1, 0, 0, 0),
                                         vector_float4(0, 1, 0, 0),
                                         vector_float4(0, 0, 1, 0),
                                         vector_float4(translationX, translationY, translationZ, 1)))
}

func matrix_perspective_right_hand(fovyRadians fovy: Float, aspectRatio: Float, nearZ: Float, farZ: Float) -> matrix_float4x4 {
    let ys = 1 / tanf(fovy * 0.5)
    let xs = ys / aspectRatio
    let zs = farZ / (nearZ - farZ)
    return matrix_float4x4.init(columns:(vector_float4(xs,  0, 0,   0),
                                         vector_float4( 0, ys, 0,   0),
                                         vector_float4( 0,  0, zs, -1),
                                         vector_float4( 0,  0, zs * nearZ, 0)))
}

/// Right-handed orthographic projection. `halfHeight` is half the visible world height.
func matrix_orthographic_right_hand(halfHeight: Float, aspectRatio: Float, nearZ: Float, farZ: Float) -> matrix_float4x4 {
    let halfWidth = halfHeight * aspectRatio
    let r = halfWidth
    let t = halfHeight
    let invW = 1 / max(2 * r, 1e-5)
    let invH = 1 / max(2 * t, 1e-5)
    let invZ = 1 / (nearZ - farZ)
    return matrix_float4x4(columns: (
        SIMD4<Float>(2 * invW, 0, 0, 0),
        SIMD4<Float>(0, 2 * invH, 0, 0),
        SIMD4<Float>(0, 0, invZ, 0),
        SIMD4<Float>(0, 0, nearZ * invZ, 1)
    ))
}

extension SIMD4 where Scalar == Float {
    var xyz: SIMD3<Float> { SIMD3(x, y, z) }
}
