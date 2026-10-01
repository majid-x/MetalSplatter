#if os(iOS) || os(macOS)

import Foundation
import Metal
import simd

/// Draws translucent character-height collision bricks after the splat pass.
final class CollisionBlockRenderer {
    private let device: MTLDevice
    private let pipelineState: MTLRenderPipelineState
    private let depthState: MTLDepthStencilState
    private let vertexBuffer: MTLBuffer
    private let indexBuffer: MTLBuffer
    private let indexCount: Int

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

        vertex VertexOut collision_block_vertex(VertexIn in [[stage_in]],
                                                constant Uniforms &uniforms [[buffer(1)]]) {
            VertexOut out;
            out.position = uniforms.modelViewProjection * float4(in.position, 1.0);
            out.color = uniforms.color;
            return out;
        }

        fragment float4 collision_block_fragment(VertexOut in [[stage_in]]) {
            return in.color;
        }
        """

        guard let library = try? device.makeLibrary(source: shader, options: nil),
              let vertexFn = library.makeFunction(name: "collision_block_vertex"),
              let fragmentFn = library.makeFunction(name: "collision_block_fragment") else {
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
        // Splat depth is not a reliable mesh depth buffer — don't clip bricks against it.
        depthDescriptor.depthCompareFunction = .always
        depthDescriptor.isDepthWriteEnabled = false
        guard let depth = device.makeDepthStencilState(descriptor: depthDescriptor) else {
            return nil
        }
        depthState = depth

        // Unit cube centered at origin, extent 1 on each axis.
        let corners: [SIMD3<Float>] = [
            SIMD3(-0.5, -0.5, -0.5), SIMD3(0.5, -0.5, -0.5),
            SIMD3(0.5, 0.5, -0.5), SIMD3(-0.5, 0.5, -0.5),
            SIMD3(-0.5, -0.5, 0.5), SIMD3(0.5, -0.5, 0.5),
            SIMD3(0.5, 0.5, 0.5), SIMD3(-0.5, 0.5, 0.5),
        ]
        var vertices = corners.map { Vertex(position: $0) }
        guard let vb = device.makeBuffer(bytes: &vertices,
                                         length: MemoryLayout<Vertex>.stride * vertices.count,
                                         options: .storageModeShared) else {
            return nil
        }
        vertexBuffer = vb

        let indices: [UInt16] = [
            0, 1, 2, 0, 2, 3,
            4, 6, 5, 4, 7, 6,
            0, 4, 5, 0, 5, 1,
            1, 5, 6, 1, 6, 2,
            2, 6, 7, 2, 7, 3,
            3, 7, 4, 3, 4, 0,
        ]
        indexCount = indices.count
        var indexCopy = indices
        guard let ib = device.makeBuffer(bytes: &indexCopy,
                                         length: MemoryLayout<UInt16>.stride * indices.count,
                                         options: .storageModeShared) else {
            return nil
        }
        indexBuffer = ib
    }

    /// Draw solid markers at positions in the same space as `viewProjection` expects (model/depth space).
    func drawMarkers(
        atModelPositions positions: [SIMD3<Float>],
        size: Float,
        color: SIMD4<Float>,
        viewProjection: matrix_float4x4,
        colorTexture: MTLTexture,
        depthTexture: MTLTexture?,
        to commandBuffer: MTLCommandBuffer
    ) {
        guard !positions.isEmpty, size > 0 else { return }

        let descriptor = MTLRenderPassDescriptor()
        descriptor.colorAttachments[0].texture = colorTexture
        descriptor.colorAttachments[0].loadAction = .load
        descriptor.colorAttachments[0].storeAction = .store
        if let depthTexture {
            descriptor.depthAttachment.texture = depthTexture
            descriptor.depthAttachment.loadAction = .load
            descriptor.depthAttachment.storeAction = .store
        }

        guard let encoder = commandBuffer.makeRenderCommandEncoder(descriptor: descriptor) else { return }
        encoder.label = "Pick Markers"
        encoder.setRenderPipelineState(pipelineState)
        encoder.setDepthStencilState(depthState)
        encoder.setCullMode(.none)
        encoder.setVertexBuffer(vertexBuffer, offset: 0, index: 0)

        let scale = matrix_float4x4(diagonal: SIMD4(size, size, size, 1))
        for position in positions {
            let translation = matrix4x4_translation(position.x, position.y, position.z)
            var uniforms = Uniforms(
                modelViewProjection: viewProjection * translation * scale,
                color: color
            )
            encoder.setVertexBytes(&uniforms, length: MemoryLayout<Uniforms>.stride, index: 1)
            encoder.drawIndexedPrimitives(
                type: .triangle,
                indexCount: indexCount,
                indexType: .uint16,
                indexBuffer: indexBuffer,
                indexBufferOffset: 0
            )
        }

        encoder.endEncoding()
    }

    func draw(
        blocks: [CollisionBlock],
        preview: CollisionBlock?,
        selectedIndex: Int?,
        basis: NavigationBasis = .yUp,
        applySplatFlip: Bool = true,
        viewProjection: matrix_float4x4,
        colorTexture: MTLTexture,
        depthTexture: MTLTexture?,
        to commandBuffer: MTLCommandBuffer
    ) {
        guard !blocks.isEmpty || preview != nil else { return }

        let descriptor = MTLRenderPassDescriptor()
        descriptor.colorAttachments[0].texture = colorTexture
        descriptor.colorAttachments[0].loadAction = .load
        descriptor.colorAttachments[0].storeAction = .store
        if let depthTexture {
            descriptor.depthAttachment.texture = depthTexture
            descriptor.depthAttachment.loadAction = .load
            descriptor.depthAttachment.storeAction = .store
        }

        guard let encoder = commandBuffer.makeRenderCommandEncoder(descriptor: descriptor) else { return }
        encoder.label = "Collision Blocks"
        encoder.setRenderPipelineState(pipelineState)
        encoder.setDepthStencilState(depthState)
        encoder.setCullMode(.none)
        encoder.setVertexBuffer(vertexBuffer, offset: 0, index: 0)

        let solid = SIMD4<Float>(0.15, 0.75, 1.0, 0.45)
        let selected = SIMD4<Float>(1.0, 0.55, 0.1, 0.55)
        let ghost = SIMD4<Float>(0.15, 0.95, 0.45, 0.35)

        func drawBlock(_ block: CollisionBlock, color: SIMD4<Float>) {
            let scale = matrix_float4x4(diagonal: SIMD4(block.width, block.height, block.depth, 1))
            let yaw = matrix4x4_rotation(radians: block.yawRadians, axis: SIMD3(0, 1, 0))
            let worldCenter = basis.toWorld(block.center)
            let model: matrix_float4x4
            if applySplatFlip {
                // Legacy path: view matrix includes 180° Z splat calibration.
                let modelCenter = SplatNavigationSpace.toModel(worldCenter)
                let rotation = matrix4x4_rotation(radians: -block.yawRadians, axis: SIMD3(0, 1, 0))
                let translation = matrix4x4_translation(modelCenter.x, modelCenter.y, modelCenter.z)
                model = translation * rotation * scale
            } else {
                let translation = matrix4x4_translation(worldCenter.x, worldCenter.y, worldCenter.z)
                model = translation * basis.worldFromLocalMatrix * yaw * scale
            }
            var uniforms = Uniforms(
                modelViewProjection: viewProjection * model,
                color: color
            )
            encoder.setVertexBytes(&uniforms, length: MemoryLayout<Uniforms>.stride, index: 1)
            encoder.drawIndexedPrimitives(
                type: .triangle,
                indexCount: indexCount,
                indexType: .uint16,
                indexBuffer: indexBuffer,
                indexBufferOffset: 0
            )
        }

        for (index, block) in blocks.enumerated() {
            drawBlock(block, color: index == selectedIndex ? selected : solid)
        }
        if let preview {
            drawBlock(preview, color: ghost)
        }

        encoder.endEncoding()
    }
}

#endif
