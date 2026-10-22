// spz-swift
// Swift port of https://github.com/nianticlabs/spz
// MIT License - Copyright (c) 2024 Niantic Labs

import Foundation
import Compression

/// Errors that can occur during SPZ operations.
public enum SPZError: Error, Sendable, LocalizedError {
    case decompressionFailed
    case compressionFailed
    case invalidHeader
    case unsupportedVersion(Int)
    case tooManyPoints(Int)
    case unsupportedSHDegree(Int)
    case readError
    case writeError
    case invalidData
    /// Decompressed (or requested) size exceeds a safe in-memory limit.
    case decompressedDataTooLarge(Int)

    public var errorDescription: String? {
        switch self {
        case .decompressionFailed:
            return "Couldn't decompress the SPZ file."
        case .compressionFailed:
            return "Couldn't compress SPZ data."
        case .invalidHeader:
            return "Invalid SPZ file header."
        case .unsupportedVersion(let version):
            return "Unsupported SPZ version (\(version))."
        case .tooManyPoints(let count):
            return "SPZ has too many points (\(count))."
        case .unsupportedSHDegree(let degree):
            return "Unsupported spherical-harmonics degree (\(degree))."
        case .readError:
            return "Couldn't read SPZ data."
        case .writeError:
            return "Couldn't write SPZ data."
        case .invalidData:
            return "Invalid SPZ data."
        case .decompressedDataTooLarge(let bytes):
            let mb = bytes / (1024 * 1024)
            return "This scene is too large to open on this device (~\(mb) MB uncompressed). Try a smaller export."
        }
    }
}

// MARK: - Gzip Compression using zlib

/// Soft cap so large SPZ files fail with a catchable error instead of
/// `swift_abortAllocationFailure` on memory-constrained devices (e.g. iPhone).
private let maxDecompressedBytes = 1_200_000_000 // ~1.2 GB

/// Decompress gzip-compressed data.
internal func decompressGzip(_ compressed: Data) throws -> Data {
    guard !compressed.isEmpty else {
        throw SPZError.decompressionFailed
    }

    // Check for gzip magic number (0x1f 0x8b)
    let isGzip = compressed.count >= 2
        && compressed[compressed.startIndex] == 0x1f
        && compressed[compressed.startIndex + 1] == 0x8b

    if isGzip {
        return try decompressGzipManual(compressed)
    } else {
        return try decompressDeflateStreaming(
            compressed,
            estimatedSize: min(max(compressed.count * 3, 65_536), maxDecompressedBytes)
        )
    }
}

/// Manual gzip decompression - skip gzip header and decompress deflate payload.
private func decompressGzipManual(_ compressed: Data) throws -> Data {
    // Gzip header: magic (2) + method (1) + flags (1) + mtime (4) + xfl (1) + os (1) = 10 bytes minimum
    guard compressed.count >= 10 else {
        throw SPZError.decompressionFailed
    }

    let flags = compressed[compressed.startIndex + 3]
    var offset = 10

    // FEXTRA
    if flags & 0x04 != 0 {
        guard compressed.count >= offset + 2 else { throw SPZError.decompressionFailed }
        let xlen = Int(compressed[compressed.startIndex + offset])
            | (Int(compressed[compressed.startIndex + offset + 1]) << 8)
        offset += 2 + xlen
    }

    // FNAME
    if flags & 0x08 != 0 {
        while offset < compressed.count && compressed[compressed.startIndex + offset] != 0 {
            offset += 1
        }
        offset += 1
    }

    // FCOMMENT
    if flags & 0x10 != 0 {
        while offset < compressed.count && compressed[compressed.startIndex + offset] != 0 {
            offset += 1
        }
        offset += 1
    }

    // FHCRC
    if flags & 0x02 != 0 {
        offset += 2
    }

    guard offset < compressed.count - 8 else {
        throw SPZError.decompressionFailed
    }

    // Trailer: CRC32 (4) + ISIZE (4) — ISIZE is uncompressed size mod 2^32.
    let isizeOffset = compressed.endIndex - 4
    let isize = Int(compressed[isizeOffset])
        | (Int(compressed[isizeOffset + 1]) << 8)
        | (Int(compressed[isizeOffset + 2]) << 16)
        | (Int(compressed[isizeOffset + 3]) << 24)

    if isize > maxDecompressedBytes {
        throw SPZError.decompressedDataTooLarge(isize)
    }

    let startIndex = compressed.startIndex + offset
    let endIndex = compressed.endIndex - 8
    let deflateData = compressed[startIndex..<endIndex]

    // Prefer footer size when present; otherwise grow from a modest estimate.
    // Never preallocate compressed×20 (that OOMs ~200MB+ SPZ files on iPhone).
    let estimated = isize > 0
        ? isize
        : min(max(deflateData.count * 3, 65_536), maxDecompressedBytes)

    return try decompressDeflateStreaming(Data(deflateData), estimatedSize: estimated)
}

/// Stream-decode zlib/deflate without preallocating compressed×20 (which OOMs on large SPZs).
/// Uses `malloc` so allocation failure is catchable instead of `swift_abortAllocationFailure`.
private func decompressDeflateStreaming(_ compressed: Data, estimatedSize: Int) throws -> Data {
    guard !compressed.isEmpty else {
        throw SPZError.decompressionFailed
    }
    if estimatedSize > maxDecompressedBytes {
        throw SPZError.decompressedDataTooLarge(estimatedSize)
    }

    var capacity = min(max(estimatedSize, 65_536), maxDecompressedBytes)

    while true {
        guard let raw = malloc(capacity) else {
            throw SPZError.decompressedDataTooLarge(capacity)
        }
        defer { free(raw) }
        let dest = raw.assumingMemoryBound(to: UInt8.self)

        let decodedSize = compressed.withUnsafeBytes { src -> Int in
            guard let base = src.bindMemory(to: UInt8.self).baseAddress else { return 0 }
            return compression_decode_buffer(
                dest,
                capacity,
                base,
                src.count,
                nil,
                COMPRESSION_ZLIB
            )
        }

        if decodedSize == 0 {
            throw SPZError.decompressionFailed
        }

        // Exact fill may mean truncation — grow and retry, but never jump to ×10 of a huge base.
        if decodedSize == capacity {
            let next: Int
            if capacity >= maxDecompressedBytes {
                throw SPZError.decompressedDataTooLarge(capacity)
            }
            next = min(capacity &+ capacity / 2, maxDecompressedBytes)
            if next <= capacity {
                throw SPZError.decompressedDataTooLarge(capacity)
            }
            capacity = next
            continue
        }

        return Data(bytes: dest, count: decodedSize)
    }
}

/// Compress data using gzip.
internal func compressGzip(_ data: Data) throws -> Data {
    guard !data.isEmpty else {
        throw SPZError.compressionFailed
    }

    // Compress using zlib deflate
    let compressedDeflate = try compressDeflate(data)

    // Wrap in gzip container
    var result = Data()

    // Gzip header
    result.append(contentsOf: [
        0x1f, 0x8b,  // Magic number
        0x08,        // Compression method (deflate)
        0x00,        // Flags
        0x00, 0x00, 0x00, 0x00,  // Modification time
        0x00,        // Extra flags
        0xff         // OS (unknown)
    ] as [UInt8])

    // Compressed data
    result.append(compressedDeflate)

    // CRC32 of original data
    let crc = crc32(data)
    result.append(UInt8(crc & 0xff))
    result.append(UInt8((crc >> 8) & 0xff))
    result.append(UInt8((crc >> 16) & 0xff))
    result.append(UInt8((crc >> 24) & 0xff))

    // Original size (mod 2^32)
    let size = UInt32(data.count & 0xffffffff)
    result.append(UInt8(size & 0xff))
    result.append(UInt8((size >> 8) & 0xff))
    result.append(UInt8((size >> 16) & 0xff))
    result.append(UInt8((size >> 24) & 0xff))

    return result
}

/// Compress data using raw deflate.
private func compressDeflate(_ data: Data) throws -> Data {
    let bufferSize = max(data.count + 1024, 1024)

    let sourceBytes = [UInt8](data)
    var destBytes = [UInt8](repeating: 0, count: bufferSize)

    let encodedSize = compression_encode_buffer(
        &destBytes,
        destBytes.count,
        sourceBytes,
        sourceBytes.count,
        nil,
        COMPRESSION_ZLIB
    )

    if encodedSize == 0 {
        throw SPZError.compressionFailed
    }

    return Data(destBytes.prefix(encodedSize))
}

// MARK: - CRC32

/// Calculate CRC32 checksum.
private func crc32(_ data: Data) -> UInt32 {
    var crc: UInt32 = 0xffffffff

    // CRC32 lookup table (IEEE 802.3 polynomial)
    let table: [UInt32] = (0..<256).map { i -> UInt32 in
        var c = UInt32(i)
        for _ in 0..<8 {
            if c & 1 != 0 {
                c = 0xedb88320 ^ (c >> 1)
            } else {
                c = c >> 1
            }
        }
        return c
    }

    for byte in data {
        let index = Int((crc ^ UInt32(byte)) & 0xff)
        crc = table[index] ^ (crc >> 8)
    }

    return crc ^ 0xffffffff
}
