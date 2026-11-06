#include "SplatProcessing.h"

vertex FragmentIn singleStageSplatVertexShader(uint vertexID [[vertex_id]],
                                               uint instanceID [[instance_id]],
                                               ushort amplificationID [[amplification_id]],
                                               device const ChunkInfo* chunks [[ buffer(BufferIndexChunks) ]],
                                               constant ChunkedSplatIndex* splatIndexArray [[ buffer(BufferIndexSplatIndex) ]],
                                               constant UniformsArray & uniformsArray [[ buffer(BufferIndexUniforms) ]]) {
    Uniforms uniforms = uniformsArray.uniforms[min(int(amplificationID), kMaxViewCount)];

    uint splatID = instanceID * uniforms.indexedSplatCount + (vertexID / 4);
    if (splatID >= uniforms.splatCount) {
        FragmentIn out;
        out.position = float4(1, 1, 0, 1);
        return out;
    }

    ChunkedSplatIndex idx = splatIndexArray[splatID];

    // Bounds check chunk index
    if (idx.chunkIndex >= uniforms.chunkCount) {
        FragmentIn out;
        out.position = float4(1, 1, 0, 1);
        return out;
    }

    ChunkInfo chunk = chunks[idx.chunkIndex];

    // Bounds check local splat index; protects against transient stale indices.
    if (idx.splatIndex >= chunk.splatCount) {
        FragmentIn out;
        out.position = float4(1, 1, 0, 1);
        return out;
    }

    if (!chunk.enabled) {
        FragmentIn out;
        out.position = float4(1, 1, 0, 1);
        return out;
    }

    Splat splat = chunk.splats[idx.splatIndex];

    return splatVertex(splat, uniforms, vertexID % 4,
                       chunk.shCoefficients, chunk.shDegree,
                       idx.splatIndex);
}

fragment half4 singleStageSplatFragmentShader(FragmentIn in [[stage_in]]) {
    half alpha = splatFragmentAlpha(in.relativePosition, in.color.a);
    return half4(alpha * in.color.rgb, alpha);
}

/// PlayCanvas-style pick pass: discard soft splat fringes so depth sticks to solid surfaces.
fragment half4 pickSplatFragmentShader(FragmentIn in [[stage_in]]) {
    half alpha = splatFragmentAlpha(in.relativePosition, in.color.a);
    // Stricter than display alpha — soft billboard fringes / floaters made measure pins
    // sit in front of the real surface, then drift when the camera moved.
    if (alpha < 0.55h) {
        discard_fragment();
    }
    return half4(1.0h, 1.0h, 1.0h, 1.0h);
}

// MARK: - SuperSplat stochastic surface pick

static uint pickHash(uint v) {
    v ^= v >> 16u;
    v *= 0x7feb352du;
    v ^= v >> 15u;
    v *= 0x846ca68bu;
    v ^= v >> 16u;
    return v;
}

/// Port of SuperSplat Picker `getSplatPickOutput`: four independent trials per fragment, each
/// kept with probability = splat alpha (falloff included) and writing normalised linear depth
/// (far = 1 where it did not survive). The pipeline MIN-blends, so each pixel keeps the nearest
/// survivor per trial regardless of draw order.
/// `planes` = (near, far) of the pick camera.
fragment float4 pickStochasticFragmentShader(FragmentIn in [[stage_in]],
                                             constant float2& planes [[buffer(0)]]) {
    half alpha = splatFragmentAlpha(in.relativePosition, in.color.a);
    float linearDepth = 1.0f / in.position.w;
    float normalizedDepth = (linearDepth - planes.x) / (planes.y - planes.x);

    uint2 p = uint2(in.position.xy);
    uint h = pickHash(p.x ^ pickHash(p.y ^ pickHash(in.pickSeed ^ as_type<uint>(normalizedDepth))));
    uint4 trials = uint4(pickHash(h),
                         pickHash(h ^ 0x9e3779b9u),
                         pickHash(h ^ 0x7f4a7c15u),
                         pickHash(h ^ 0x2545f491u));
    bool4 keep = (float4(trials >> 8u) * (1.0f / 16777216.0f)) < float4(float(alpha));
    if (!any(keep)) {
        discard_fragment();
    }
    return select(float4(1.0f), float4(normalizedDepth), keep);
}
