// spz-swift
// Swift port of https://github.com/nianticlabs/spz
// MIT License - Copyright (c) 2024 Niantic Labs

import Foundation

/// Options for unpacking SPZ data.
public struct UnpackOptions: Sendable {
    /// Target coordinate system for the unpacked data.
    public var to: CoordinateSystem

    public init(to: CoordinateSystem = .unspecified) {
        self.to = to
    }
}

// MARK: - Loading Functions

/// Load a GaussianCloud from SPZ data.
/// - Parameters:
///   - data: The SPZ file data (gzip compressed).
///   - options: Unpacking options including target coordinate system.
/// - Returns: The unpacked GaussianCloud.
public func loadSpz(_ data: Data, options: UnpackOptions = UnpackOptions()) throws -> GaussianCloud {
    let packed = try loadSpzPacked(data)
    return unpackGaussians(packed, options: options)
}

/// Load a GaussianCloud from an SPZ file.
/// - Parameters:
///   - url: URL to the SPZ file.
///   - options: Unpacking options including target coordinate system.
/// - Returns: The unpacked GaussianCloud.
public func loadSpz(from url: URL, options: UnpackOptions = UnpackOptions()) throws -> GaussianCloud {
    let data = try Data(contentsOf: url, options: [.mappedIfSafe])
    return try loadSpz(data, options: options)
}

/// Load packed gaussians from SPZ data (without unpacking).
/// - Parameter data: The SPZ file data (gzip compressed).
/// - Returns: The packed gaussians structure.
public func loadSpzPacked(_ data: Data) throws -> PackedGaussians {
    let decompressed = try decompressGzip(data)
    return try deserializePackedGaussians(decompressed)
}

/// Load packed gaussians from an SPZ file.
/// - Parameter url: URL to the SPZ file.
/// - Returns: The packed gaussians structure.
public func loadSpzPacked(from url: URL) throws -> PackedGaussians {
    let data = try Data(contentsOf: url, options: [.mappedIfSafe])
    return try loadSpzPacked(data)
}

// MARK: - Deserialization

/// Deserialize packed gaussians from uncompressed data.
internal func deserializePackedGaussians(_ data: Data) throws -> PackedGaussians {
    let maxPointsToRead: Int32 = 10_000_000

    guard data.count >= PackedGaussiansHeader.size else {
        throw SPZError.invalidHeader
    }

    // Read header
    var offset = 0

    let magic = data.withUnsafeBytes { ptr -> UInt32 in
        ptr.load(fromByteOffset: offset, as: UInt32.self)
    }
    offset += 4

    guard magic == PackedGaussiansHeader.magic else {
        throw SPZError.invalidHeader
    }

    let version = data.withUnsafeBytes { ptr -> UInt32 in
        ptr.load(fromByteOffset: offset, as: UInt32.self)
    }
    offset += 4

    guard version >= 1 && version <= 3 else {
        throw SPZError.unsupportedVersion(Int(version))
    }

    let numPoints = data.withUnsafeBytes { ptr -> UInt32 in
        ptr.load(fromByteOffset: offset, as: UInt32.self)
    }
    offset += 4

    guard numPoints <= maxPointsToRead else {
        throw SPZError.tooManyPoints(Int(numPoints))
    }

    let shDegree = data[offset]
    offset += 1

    guard shDegree <= 3 else {
        throw SPZError.unsupportedSHDegree(Int(shDegree))
    }

    let fractionalBits = data[offset]
    offset += 1

    let flags = data[offset]
    offset += 1

    // Skip reserved byte
    offset += 1

    // Calculate sizes
    let usesFloat16 = version == 1
    let usesQuaternionSmallestThree = version >= 3
    let shDim = dimForDegree(Int32(shDegree))

    let positionBytes = Int(numPoints) * 3 * (usesFloat16 ? 2 : 3)
    let scaleBytes = Int(numPoints) * 3
    let rotationBytes = Int(numPoints) * (usesQuaternionSmallestThree ? 4 : 3)
    let alphaBytes = Int(numPoints)
    let colorBytes = Int(numPoints) * 3
    let shBytes = Int(numPoints) * Int(shDim) * 3

    let totalBytes = offset + positionBytes + alphaBytes + colorBytes + scaleBytes + rotationBytes + shBytes

    guard data.count >= totalBytes else {
        throw SPZError.readError
    }

    // Read data arrays
    var result = PackedGaussians()
    result.numPoints = Int32(numPoints)
    result.shDegree = Int32(shDegree)
    result.fractionalBits = Int32(fractionalBits)
    result.antialiased = (flags & PackedGaussiansHeader.flagAntialiased) != 0
    result.usesQuaternionSmallestThree = usesQuaternionSmallestThree

    result.positions = Array(data[offset..<(offset + positionBytes)])
    offset += positionBytes

    result.alphas = Array(data[offset..<(offset + alphaBytes)])
    offset += alphaBytes

    result.colors = Array(data[offset..<(offset + colorBytes)])
    offset += colorBytes

    result.scales = Array(data[offset..<(offset + scaleBytes)])
    offset += scaleBytes

    result.rotations = Array(data[offset..<(offset + rotationBytes)])
    offset += rotationBytes

    result.sh = Array(data[offset..<(offset + shBytes)])

    return result
}

// MARK: - Unpacking

/// Unpack compressed gaussians to full precision.
public func unpackGaussians(_ packed: PackedGaussians, options: UnpackOptions = UnpackOptions()) -> GaussianCloud {
    let numPoints = packed.numPoints
    let shDim = dimForDegree(packed.shDegree)
    let usesFloat16 = packed.usesFloat16
    let usesQuaternionSmallestThree = packed.usesQuaternionSmallestThree

    var result = GaussianCloud()
    result.numPoints = numPoints
    result.shDegree = packed.shDegree
    result.antialiased = packed.antialiased
    result.positions = Array(repeating: 0, count: Int(numPoints) * 3)
    result.scales = Array(repeating: 0, count: Int(numPoints) * 3)
    result.rotations = Array(repeating: 0, count: Int(numPoints) * 4)
    result.alphas = Array(repeating: 0, count: Int(numPoints))
    result.colors = Array(repeating: 0, count: Int(numPoints) * 3)
    result.sh = Array(repeating: 0, count: Int(numPoints) * Int(shDim) * 3)

    // Decode positions
    if usesFloat16 {
        // Legacy float16 format
        for i in 0..<(Int(numPoints) * 3) {
            let halfValue = UInt16(packed.positions[i * 2]) | (UInt16(packed.positions[i * 2 + 1]) << 8)
            result.positions[i] = halfToFloat(halfValue)
        }
    } else {
        // 24-bit fixed point coordinates
        let scale = 1.0 / Float(1 << packed.fractionalBits)
        for i in 0..<(Int(numPoints) * 3) {
            var fixed32 = Int32(packed.positions[i * 3 + 0])
            fixed32 |= Int32(packed.positions[i * 3 + 1]) << 8
            fixed32 |= Int32(packed.positions[i * 3 + 2]) << 16
            // Sign extension
            if (fixed32 & 0x800000) != 0 {
                fixed32 |= Int32(bitPattern: 0xff000000)
            }
            result.positions[i] = Float(fixed32) * scale
        }
    }

    // Decode scales
    for i in 0..<(Int(numPoints) * 3) {
        result.scales[i] = Float(packed.scales[i]) / 16.0 - 10.0
    }

    // Decode rotations
    for i in 0..<Int(numPoints) {
        let rotation: SIMD4<Float>
        if usesQuaternionSmallestThree {
            let rotBytes = Array(packed.rotations[(i * 4)..<(i * 4 + 4)])
            rotation = unpackQuaternionSmallestThree(rotBytes)
        } else {
            let rotBytes = Array(packed.rotations[(i * 3)..<(i * 3 + 3)])
            rotation = unpackQuaternionFirstThree(rotBytes)
        }
        result.rotations[i * 4 + 0] = rotation.x
        result.rotations[i * 4 + 1] = rotation.y
        result.rotations[i * 4 + 2] = rotation.z
        result.rotations[i * 4 + 3] = rotation.w
    }

    // Decode alphas
    for i in 0..<Int(numPoints) {
        result.alphas[i] = invSigmoid(Float(packed.alphas[i]) / 255.0)
    }

    // Decode colors
    for i in 0..<(Int(numPoints) * 3) {
        result.colors[i] = ((Float(packed.colors[i]) / 255.0) - 0.5) / colorScale
    }

    // Decode spherical harmonics
    for i in 0..<packed.sh.count {
        result.sh[i] = unquantizeSH(packed.sh[i])
    }

    // Apply coordinate conversion
    result.convertCoordinates(from: .rub, to: options.to)

    return result
}
