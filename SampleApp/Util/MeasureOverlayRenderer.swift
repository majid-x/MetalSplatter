#if os(iOS) || os(macOS) || os(visionOS)

import Foundation
import Metal
import simd

/// Draws measure pins (spheres), hover reticle (cone), and laser segments after the splat pass.
/// Matches PlayCanvas SplatMeasurer primitives: sphere pins, cone reticle, thin beams.
final class MeasureOverlayRenderer {
    private let device: MTLDevice
    private let pipelineState: MTLRenderPipelineState
    private let depthState: MTLDepthStencilState

    private let sphereVertexBuffer: MTLBuffer
    private let sphereIndexBuffer: MTLBuffer
    private let sphereIndexCount: Int

    private let coneVertexBuffer: MTLBuffer
    private let coneIndexBuffer: MTLBuffer
    private let coneIndexCount: Int

    private let beamVertexBuffer: MTLBuffer
    private let beamIndexBuffer: MTLBuffer
    private let beamIndexCount: Int

    private struct Vertex {
        var position: SIMD3<Float>
    }

    private struct Uniforms {
        var modelViewProjection: matrix_float4x4
        var color: SIMD4<Float>
    }

    init?(device: MTLDevice, colorFormat: MTLPixelFormat, depthFormat: MTLPixelFormat, sampleCount: Int) {
        self.device = device

        let shader = """
        #include <metal_stdlib>
        using namespace metal;

        struct VertexIn {
            float3 position [[attribute(0)]];
        };

        struct VertexOut {
            float4 position [[position]];
            float4 color;
        };

        struct Uniforms {
            float4x4 modelViewProjection;
            float4 color;
        };

        vertex VertexOut measure_overlay_vertex(VertexIn in [[stage_in]],
                                                constant Uniforms &uniforms [[buffer(1)]]) {
            VertexOut out;
            out.position = uniforms.modelViewProjection * float4(in.position, 1.0);
            out.color = uniforms.color;
            return out;
        }

        fragment float4 measure_overlay_fragment(VertexOut in [[stage_in]]) {
            return in.color;
        }
        """

        guard let library = try? device.makeLibrary(source: shader, options: nil),
              let vertexFn = library.makeFunction(name: "measure_overlay_vertex"),
              let fragmentFn = library.makeFunction(name: "measure_overlay_fragment") else {
            return nil
        }

        let vertexDescriptor = MTLVertexDescriptor()
        vertexDescriptor.attributes[0].format = .float3
        vertexDescriptor.attributes[0].offset = 0
        vertexDescriptor.attributes[0].bufferIndex = 0
        vertexDescriptor.layouts[0].stride = MemoryLayout<Vertex>.stride

        let pipelineDescriptor = MTLRenderPipelineDescriptor()
        pipelineDescriptor.vertexFunction = vertexFn
        pipelineDescriptor.fragmentFunction = fragmentFn
        pipelineDescriptor.vertexDescriptor = vertexDescriptor
        pipelineDescriptor.colorAttachments[0].pixelFormat = colorFormat
        pipelineDescriptor.colorAttachments[0].isBlendingEnabled = true
        pipelineDescriptor.colorAttachments[0].rgbBlendOperation = .add
        pipelineDescriptor.colorAttachments[0].alphaBlendOperation = .add
        pipelineDescriptor.colorAttachments[0].sourceRGBBlendFactor = .sourceAlpha
        pipelineDescriptor.colorAttachments[0].destinationRGBBlendFactor = .oneMinusSourceAlpha
        pipelineDescriptor.colorAttachments[0].sourceAlphaBlendFactor = .one
        pipelineDescriptor.colorAttachments[0].destinationAlphaBlendFactor = .oneMinusSourceAlpha
        pipelineDescriptor.depthAttachmentPixelFormat = depthFormat
        pipelineDescriptor.rasterSampleCount = sampleCount

        guard let pipeline = try? device.makeRenderPipelineState(descriptor: pipelineDescriptor) else {
            return nil
        }
        pipelineState = pipeline

        let depthDescriptor = MTLDepthStencilDescriptor()
        depthDescriptor.depthCompareFunction = .always
        depthDescriptor.isDepthWriteEnabled = false
        guard let depth = device.makeDepthStencilState(descriptor: depthDescriptor) else {
            return nil
        }
        depthState = depth

        let sphere = Self.makeUVSphere(segments: 16, rings: 12)
        guard let sv = device.makeBuffer(bytes: sphere.vertices,
                                         length: MemoryLayout<Vertex>.stride * sphere.vertices.count,
                                         options: .storageModeShared),
              let si = device.makeBuffer(bytes: sphere.indices,
                                         length: MemoryLayout<UInt16>.stride * sphere.indices.count,
                                         options: .storageModeShared) else {
            return nil
        }
        sphereVertexBuffer = sv
        sphereIndexBuffer = si
        sphereIndexCount = sphere.indices.count

        let cone = Self.makeCone(segments: 16)
        guard let cv = device.makeBuffer(bytes: cone.vertices,
                                         length: MemoryLayout<Vertex>.stride * cone.vertices.count,
                                         options: .storageModeShared),
              let ci = device.makeBuffer(bytes: cone.indices,
                                         length: MemoryLayout<UInt16>.stride * cone.indices.count,
                                         options: .storageModeShared) else {
            return nil
        }
        coneVertexBuffer = cv
        coneIndexBuffer = ci
        coneIndexCount = cone.indices.count

        let beam = Self.makeUnitCube()
        guard let bv = device.makeBuffer(bytes: beam.vertices,
                                         length: MemoryLayout<Vertex>.stride * beam.vertices.count,
                                         options: .storageModeShared),
              let bi = device.makeBuffer(bytes: beam.indices,
                                         length: MemoryLayout<UInt16>.stride * beam.indices.count,
                                         options: .storageModeShared) else {
            return nil
        }
        beamVertexBuffer = bv
        beamIndexBuffer = bi
        beamIndexCount = beam.indices.count
    }

    /// Sphere pins at model-space positions (PlayCanvas `createDebugMarker`).
    func drawPins(
        atModelPositions positions: [SIMD3<Float>],
        diameter: Float,
        color: SIMD4<Float>,
        viewProjection: matrix_float4x4,
        colorTexture: MTLTexture,
        depthTexture: MTLTexture?,
        to commandBuffer: MTLCommandBuffer
    ) {
        guard !positions.isEmpty, diameter > 0 else { return }
        guard let encoder = makeEncoder(
            colorTexture: colorTexture,
            depthTexture: depthTexture,
            commandBuffer: commandBuffer,
            label: "Measure Pins"
        ) else { return }

        let scale = matrix_float4x4(diagonal: SIMD4(diameter, diameter, diameter, 1))
        for position in positions {
            let translation = matrix4x4_translation(position.x, position.y, position.z)
            var uniforms = Uniforms(
                modelViewProjection: viewProjection * translation * scale,
                color: color
            )
            encoder.setVertexBuffer(sphereVertexBuffer, offset: 0, index: 0)
            encoder.setVertexBytes(&uniforms, length: MemoryLayout<Uniforms>.stride, index: 1)
            encoder.drawIndexedPrimitives(
                type: .triangle,
                indexCount: sphereIndexCount,
                indexType: .uint16,
                indexBuffer: sphereIndexBuffer,
                indexBufferOffset: 0
            )
        }
        encoder.endEncoding()
    }

    /// Cyan cone hover reticle (PlayCanvas default `reticleType: cone`, scale ~0.06×0.09×0.06).
    func drawReticle(
        atModelPosition position: SIMD3<Float>,
        /// PlayCanvas reticleScaleOffset default.
        scale: SIMD3<Float> = SIMD3(0.06, 0.09, 0.06),
        /// Pulse multiplier (PlayCanvas ~0.75…1.25).
        pulse: Float = 1,
        color: SIMD4<Float>,
        viewProjection: matrix_float4x4,
        colorTexture: MTLTexture,
        depthTexture: MTLTexture?,
        to commandBuffer: MTLCommandBuffer
    ) {
        guard let encoder = makeEncoder(
            colorTexture: colorTexture,
            depthTexture: depthTexture,
            commandBuffer: commandBuffer,
            label: "Measure Reticle"
        ) else { return }

        // PlayCanvas reticleRotOffset [180,0,0]: tip points into the surface (-Y).
        let flip = matrix4x4_rotation(radians: .pi, axis: SIMD3(1, 0, 0))
        let s = scale * pulse
        let scaleM = matrix_float4x4(diagonal: SIMD4(s.x, s.y, s.z, 1))
        let translation = matrix4x4_translation(position.x, position.y, position.z)
        var uniforms = Uniforms(
            modelViewProjection: viewProjection * translation * flip * scaleM,
            color: color
        )
        encoder.setVertexBuffer(coneVertexBuffer, offset: 0, index: 0)
        encoder.setVertexBytes(&uniforms, length: MemoryLayout<Uniforms>.stride, index: 1)
        encoder.drawIndexedPrimitives(
            type: .triangle,
            indexCount: coneIndexCount,
            indexType: .uint16,
            indexBuffer: coneIndexBuffer,
            indexBufferOffset: 0
        )
        encoder.endEncoding()
    }

    /// Thin beams between point pairs (PlayCanvas cylinder laser approximated as a scaled box).
    func drawSegments(
        segments: [(SIMD3<Float>, SIMD3<Float>)],
        thickness: Float,
        color: SIMD4<Float>,
        viewProjection: matrix_float4x4,
        colorTexture: MTLTexture,
        depthTexture: MTLTexture?,
        to commandBuffer: MTLCommandBuffer
    ) {
        guard !segments.isEmpty, thickness > 0 else { return }
        guard let encoder = makeEncoder(
            colorTexture: colorTexture,
            depthTexture: depthTexture,
            commandBuffer: commandBuffer,
            label: "Measure Lasers"
        ) else { return }

        for (a, b) in segments {
            let delta = b - a
            let length = simd_length(delta)
            guard length > 1e-5 else { continue }
            let direction = delta / length
            let mid = (a + b) * 0.5

            let zAxis = SIMD3<Float>(0, 0, 1)
            let rotation: matrix_float4x4
            let axis = simd_cross(zAxis, direction)
            let axisLen = simd_length(axis)
            if axisLen < 1e-5 {
                rotation = simd_dot(zAxis, direction) > 0
                    ? matrix_identity_float4x4
                    : matrix4x4_rotation(radians: .pi, axis: SIMD3(1, 0, 0))
            } else {
                let angle = acos(max(-1, min(1, simd_dot(zAxis, direction))))
                rotation = matrix4x4_rotation(radians: angle, axis: axis / axisLen)
            }

            let scale = matrix_float4x4(diagonal: SIMD4(thickness, thickness, length, 1))
            let translation = matrix4x4_translation(mid.x, mid.y, mid.z)
            var uniforms = Uniforms(
                modelViewProjection: viewProjection * translation * rotation * scale,
                color: color
            )
            encoder.setVertexBuffer(beamVertexBuffer, offset: 0, index: 0)
            encoder.setVertexBytes(&uniforms, length: MemoryLayout<Uniforms>.stride, index: 1)
            encoder.drawIndexedPrimitives(
                type: .triangle,
                indexCount: beamIndexCount,
                indexType: .uint16,
                indexBuffer: beamIndexBuffer,
                indexBufferOffset: 0
            )
        }
        encoder.endEncoding()
    }

    private func makeEncoder(
        colorTexture: MTLTexture,
        depthTexture: MTLTexture?,
        commandBuffer: MTLCommandBuffer,
        label: String
    ) -> MTLRenderCommandEncoder? {
        let descriptor = MTLRenderPassDescriptor()
        descriptor.colorAttachments[0].texture = colorTexture
        descriptor.colorAttachments[0].loadAction = .load
        descriptor.colorAttachments[0].storeAction = .store
        if let depthTexture {
            descriptor.depthAttachment.texture = depthTexture
            descriptor.depthAttachment.loadAction = .load
            descriptor.depthAttachment.storeAction = .store
        }
        guard let encoder = commandBuffer.makeRenderCommandEncoder(descriptor: descriptor) else {
            return nil
        }
        encoder.label = label
        encoder.setRenderPipelineState(pipelineState)
        encoder.setDepthStencilState(depthState)
        encoder.setCullMode(.none)
        return encoder
    }

    // MARK: - Mesh builders

    private static func makeUVSphere(segments: Int, rings: Int) -> (vertices: [Vertex], indices: [UInt16]) {
        var vertices: [Vertex] = []
        vertices.reserveCapacity((rings + 1) * (segments + 1))
        for ring in 0...rings {
            let v = Float(ring) / Float(rings)
            let phi = v * .pi
            let y = cos(phi)
            let r = sin(phi)
            for seg in 0...segments {
                let u = Float(seg) / Float(segments)
                let theta = u * 2 * .pi
                let x = r * cos(theta)
                let z = r * sin(theta)
                vertices.append(Vertex(position: SIMD3(x, y, z) * 0.5)) // diameter 1
            }
        }
        var indices: [UInt16] = []
        let stride = segments + 1
        for ring in 0..<rings {
            for seg in 0..<segments {
                let i0 = UInt16(ring * stride + seg)
                let i1 = UInt16(ring * stride + seg + 1)
                let i2 = UInt16((ring + 1) * stride + seg)
                let i3 = UInt16((ring + 1) * stride + seg + 1)
                indices.append(contentsOf: [i0, i2, i1, i1, i2, i3])
            }
        }
        return (vertices, indices)
    }

    /// Unit cone: apex at +Y 0.5, base ring at Y -0.5, radius 0.5 (PlayCanvas-style).
    private static func makeCone(segments: Int) -> (vertices: [Vertex], indices: [UInt16]) {
        var vertices: [Vertex] = [Vertex(position: SIMD3(0, 0.5, 0))]
        for i in 0..<segments {
            let t = Float(i) / Float(segments) * 2 * .pi
            vertices.append(Vertex(position: SIMD3(cos(t) * 0.5, -0.5, sin(t) * 0.5)))
        }
        // base center
        let baseCenter = UInt16(vertices.count)
        vertices.append(Vertex(position: SIMD3(0, -0.5, 0)))

        var indices: [UInt16] = []
        for i in 0..<segments {
            let a = UInt16(1 + i)
            let b = UInt16(1 + (i + 1) % segments)
            indices.append(contentsOf: [0, a, b])
            indices.append(contentsOf: [baseCenter, b, a])
        }
        return (vertices, indices)
    }

    private static func makeUnitCube() -> (vertices: [Vertex], indices: [UInt16]) {
        let corners: [SIMD3<Float>] = [
            SIMD3(-0.5, -0.5, -0.5), SIMD3(0.5, -0.5, -0.5),
            SIMD3(0.5, 0.5, -0.5), SIMD3(-0.5, 0.5, -0.5),
            SIMD3(-0.5, -0.5, 0.5), SIMD3(0.5, -0.5, 0.5),
            SIMD3(0.5, 0.5, 0.5), SIMD3(-0.5, 0.5, 0.5),
        ]
        let vertices = corners.map { Vertex(position: $0) }
        let indices: [UInt16] = [
            0, 1, 2, 0, 2, 3,
            4, 6, 5, 4, 7, 6,
            0, 4, 5, 0, 5, 1,
            1, 5, 6, 1, 6, 2,
            2, 6, 7, 2, 7, 3,
            3, 7, 4, 3, 4, 0,
        ]
        return (vertices, indices)
    }
}

#endif
