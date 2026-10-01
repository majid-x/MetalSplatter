import Foundation
import zlib

/// ZIP reader (stored + deflate) that works inside App Sandbox.
/// Uses the central directory so data-descriptor archives (common Deflate zips) work.
enum SandboxedZipExtractor {
    enum Error: LocalizedError {
        case truncatedArchive
        case unsupportedCompression(UInt16)
        case inflateFailed
        case invalidPath(String)
        case missingCentralDirectory

        var errorDescription: String? {
            switch self {
            case .truncatedArchive:
                return "The project archive looks incomplete or damaged"
            case .unsupportedCompression:
                return "This project archive uses an unsupported compression format"
            case .inflateFailed:
                return "Couldn't unpack a file inside the project archive"
            case .invalidPath:
                return "The project archive contains an invalid file path"
            case .missingCentralDirectory:
                return "The project archive is missing its file index"
            }
        }
    }

    private struct CentralEntry {
        let compression: UInt16
        let compressedSize: Int
        let uncompressedSize: Int
        let localHeaderOffset: Int
        let name: String
        let isDirectory: Bool
    }

    static func extract(zipURL: URL, to destination: URL) throws {
        let data = try Data(contentsOf: zipURL)
        try extract(data: data, to: destination)
    }

    static func extract(data: Data, to destination: URL) throws {
        let fm = FileManager.default
        try fm.createDirectory(at: destination, withIntermediateDirectories: true)

        let entries = try parseCentralDirectory(data)
        for entry in entries {
            if entry.name.hasPrefix("__MACOSX/") || entry.name.contains("..") {
                continue
            }

            let outURL = sanitizedURL(destination: destination, entryName: entry.name)
            if entry.isDirectory || entry.name.hasSuffix("/") {
                try fm.createDirectory(at: outURL, withIntermediateDirectories: true)
                continue
            }

            try fm.createDirectory(
                at: outURL.deletingLastPathComponent(),
                withIntermediateDirectories: true
            )

            let compressed = try localFilePayload(data: data, entry: entry)
            let uncompressed: Data
            switch entry.compression {
            case 0:
                uncompressed = compressed
            case 8:
                uncompressed = try inflateRaw(compressed, expectedSize: max(entry.uncompressedSize, 1))
            default:
                throw Error.unsupportedCompression(entry.compression)
            }
            try uncompressed.write(to: outURL, options: .atomic)
        }
    }

    // MARK: - Central directory

    private static func parseCentralDirectory(_ data: Data) throws -> [CentralEntry] {
        guard let eocdOffset = findEOCDOffset(in: data) else {
            throw Error.missingCentralDirectory
        }

        let totalEntries = Int(readUInt16(data, eocdOffset + 10))
        let centralSize = Int(readUInt32(data, eocdOffset + 12))
        let centralOffset = Int(readUInt32(data, eocdOffset + 16))
        guard centralOffset >= 0,
              centralSize >= 0,
              centralOffset + centralSize <= data.count else {
            throw Error.truncatedArchive
        }

        var entries: [CentralEntry] = []
        entries.reserveCapacity(totalEntries)

        var offset = centralOffset
        let centralEnd = centralOffset + centralSize
        while offset + 46 <= centralEnd {
            let sig = readUInt32(data, offset)
            guard sig == 0x0201_4B50 else { break }

            let compression = readUInt16(data, offset + 10)
            let compressedSize = Int(readUInt32(data, offset + 20))
            let uncompressedSize = Int(readUInt32(data, offset + 24))
            let nameLen = Int(readUInt16(data, offset + 28))
            let extraLen = Int(readUInt16(data, offset + 30))
            let commentLen = Int(readUInt16(data, offset + 32))
            let localHeaderOffset = Int(readUInt32(data, offset + 42))

            let nameStart = offset + 46
            let nameEnd = nameStart + nameLen
            guard nameEnd + extraLen + commentLen <= data.count else {
                throw Error.truncatedArchive
            }

            let nameData = data.subdata(in: nameStart..<nameEnd)
            guard let name = String(data: nameData, encoding: .utf8), !name.isEmpty else {
                throw Error.invalidPath("(binary)")
            }

            entries.append(
                CentralEntry(
                    compression: compression,
                    compressedSize: compressedSize,
                    uncompressedSize: uncompressedSize,
                    localHeaderOffset: localHeaderOffset,
                    name: name,
                    isDirectory: name.hasSuffix("/")
                )
            )

            offset = nameEnd + extraLen + commentLen
        }

        return entries
    }

    /// EOCD is near the end; comment can be up to 64KB.
    private static func findEOCDOffset(in data: Data) -> Int? {
        guard data.count >= 22 else { return nil }
        let maxComment = min(65_535, data.count - 22)
        let start = data.count - 22
        for back in 0...maxComment {
            let offset = start - back
            if readUInt32(data, offset) == 0x0605_4B50 {
                return offset
            }
        }
        return nil
    }

    private static func localFilePayload(data: Data, entry: CentralEntry) throws -> Data {
        let localOffset = entry.localHeaderOffset
        guard localOffset + 30 <= data.count,
              readUInt32(data, localOffset) == 0x0403_4B50 else {
            throw Error.truncatedArchive
        }

        let nameLen = Int(readUInt16(data, localOffset + 26))
        let extraLen = Int(readUInt16(data, localOffset + 28))
        let payloadStart = localOffset + 30 + nameLen + extraLen
        let payloadEnd = payloadStart + entry.compressedSize
        guard payloadStart >= 0, payloadEnd <= data.count else {
            throw Error.truncatedArchive
        }
        return data.subdata(in: payloadStart..<payloadEnd)
    }

    private static func sanitizedURL(destination: URL, entryName: String) -> URL {
        let parts = entryName.split(separator: "/").map(String.init).filter { $0 != ".." && $0 != "." }
        return parts.reduce(destination) { $0.appendingPathComponent($1) }
    }

    /// ZIP local-file payloads use raw DEFLATE (windowBits = -15).
    private static func inflateRaw(_ input: Data, expectedSize: Int) throws -> Data {
        if input.isEmpty {
            return Data()
        }

        var stream = z_stream()
        var status = inflateInit2_(
            &stream,
            -MAX_WBITS,
            ZLIB_VERSION,
            Int32(MemoryLayout<z_stream>.size)
        )
        guard status == Z_OK else { throw Error.inflateFailed }
        defer { inflateEnd(&stream) }

        var output = [UInt8](repeating: 0, count: max(expectedSize, 1024))
        var outputCount = 0

        try input.withUnsafeBytes { (srcBuffer: UnsafeRawBufferPointer) in
            guard let srcBase = srcBuffer.bindMemory(to: Bytef.self).baseAddress else {
                throw Error.inflateFailed
            }
            stream.next_in = UnsafeMutablePointer(mutating: srcBase)
            stream.avail_in = uInt(input.count)

            while true {
                if outputCount == output.count {
                    output.append(contentsOf: repeatElement(0, count: max(output.count, 64 * 1024)))
                }
                let remaining = output.count - outputCount
                let produced: Int = output.withUnsafeMutableBytes { dstBuffer in
                    let dst = dstBuffer.bindMemory(to: Bytef.self).baseAddress!.advanced(by: outputCount)
                    stream.next_out = dst
                    stream.avail_out = uInt(remaining)
                    status = inflate(&stream, Z_NO_FLUSH)
                    return remaining - Int(stream.avail_out)
                }
                outputCount += produced

                if status == Z_STREAM_END {
                    break
                }
                if status != Z_OK {
                    throw Error.inflateFailed
                }
                if stream.avail_in == 0 && stream.avail_out > 0 {
                    break
                }
            }
        }

        guard status == Z_STREAM_END || outputCount > 0 else {
            throw Error.inflateFailed
        }
        return Data(output.prefix(outputCount))
    }

    private static func readUInt16(_ data: Data, _ offset: Int) -> UInt16 {
        data.withUnsafeBytes { $0.loadUnaligned(fromByteOffset: offset, as: UInt16.self) }
    }

    private static func readUInt32(_ data: Data, _ offset: Int) -> UInt32 {
        data.withUnsafeBytes { $0.loadUnaligned(fromByteOffset: offset, as: UInt32.self) }
    }
}
