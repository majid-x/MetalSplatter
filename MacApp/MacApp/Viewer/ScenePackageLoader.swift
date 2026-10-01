import Foundation
import UniformTypeIdentifiers

enum ScenePackageLoader {
    struct Contents {
        let modelURL: URL
        let navigation: SceneNavigationData?
    }

    enum LoadError: LocalizedError {
        case unsupportedType
        case unzipFailed
        case unzipFailedDetail(String)
        case insufficientDiskSpace(neededBytes: Int64, availableBytes: Int64)
        case missingModel
        case invalidNavigation(String)

        var errorDescription: String? {
            switch self {
            case .unsupportedType:
                return "This file type isn't supported. Use a project package or a .ply / .splat / .spz file."
            case .unzipFailed:
                return "Couldn't open the project package. Try downloading again."
            case .unzipFailedDetail:
                return "Couldn't open the project package. Try downloading again."
            case .insufficientDiskSpace(let needed, let available):
                let needMB = max(1, needed / (1024 * 1024))
                let availMB = max(0, available / (1024 * 1024))
                return "Not enough storage to open this project (need about \(needMB) MB, \(availMB) MB free)."
            case .missingModel:
                return "This project package doesn't include a 3D scene file."
            case .invalidNavigation:
                return "This project's navigation data couldn't be read."
            }
        }
    }

    private static let modelExtensions: Set<String> = ["ply", "splat", "spz"]

    static func load(from url: URL, extractDirectory: URL? = nil) throws -> Contents {
        let ext = url.pathExtension.lowercased()
        if ext == "zip" {
            return try loadZip(url, extractDirectory: extractDirectory)
        }
        if modelExtensions.contains(ext) {
            // Loose model files open as-is — never look for a sibling nav.txt.
            return Contents(modelURL: url, navigation: nil)
        }
        throw LoadError.unsupportedType
    }

    private static func loadZip(_ zipURL: URL, extractDirectory: URL? = nil) throws -> Contents {
        let fm = FileManager.default
        let dest: URL
        if let extractDirectory {
            dest = extractDirectory
        } else {
            // Prefer Caches over /tmp — same volume usually, but a stable path we can reuse.
            let caches = fm.urls(for: .cachesDirectory, in: .userDomainMask).first
                ?? fm.temporaryDirectory
            dest = caches
                .appendingPathComponent("MetalSplatterScenes", isDirectory: true)
                .appendingPathComponent(packageCacheKey(for: zipURL), isDirectory: true)
        }

        if let modelURL = firstModel(in: dest), fm.fileExists(atPath: modelURL.path) {
            let navigation: SceneNavigationData?
            if let navURL = firstNavigation(in: dest) {
                let text = try String(contentsOf: navURL, encoding: .utf8)
                do {
                    navigation = try SceneNavigationData.parse(text)
                } catch {
                    throw LoadError.invalidNavigation(error.localizedDescription)
                }
            } else {
                navigation = nil
            }
            return Contents(modelURL: modelURL, navigation: navigation)
        }

        if fm.fileExists(atPath: dest.path) {
            try? fm.removeItem(at: dest)
        }
        try fm.createDirectory(at: dest, withIntermediateDirectories: true)

        try ensureDiskSpaceForUnzip(of: zipURL, ontoVolumeOf: dest)
        try unzip(zipURL, to: dest)

        guard let modelURL = firstModel(in: dest) else {
            throw LoadError.missingModel
        }

        let navigation: SceneNavigationData?
        if let navURL = firstNavigation(in: dest) {
            let text = try String(contentsOf: navURL, encoding: .utf8)
            do {
                navigation = try SceneNavigationData.parse(text)
            } catch {
                throw LoadError.invalidNavigation(error.localizedDescription)
            }
        } else {
            navigation = nil
        }

        return Contents(modelURL: modelURL, navigation: navigation)
    }

    private static func packageCacheKey(for zipURL: URL) -> String {
        let values = try? zipURL.resourceValues(forKeys: [.fileSizeKey, .contentModificationDateKey])
        let size = values?.fileSize ?? 0
        let modified = Int((values?.contentModificationDate ?? .distantPast).timeIntervalSince1970)
        let name = zipURL.deletingPathExtension().lastPathComponent
            .replacingOccurrences(of: " ", with: "_")
        return "\(name)-\(size)-\(modified)"
    }

    private static func ensureDiskSpaceForUnzip(of zipURL: URL, ontoVolumeOf destination: URL) throws {
        let zipSize = (try? zipURL.resourceValues(forKeys: [.fileSizeKey]).fileSize).map(Int64.init) ?? 0
        // Compressed archives often expand ~1.1–1.5×; require zip size + 100MB headroom.
        let needed = max(zipSize + 100 * 1024 * 1024, zipSize * 2)
        let available = (try? destination.resourceValues(forKeys: [.volumeAvailableCapacityForImportantUsageKey])
            .volumeAvailableCapacityForImportantUsage) ?? 0
        if available > 0, available < needed {
            throw LoadError.insufficientDiskSpace(neededBytes: needed, availableBytes: available)
        }
    }

    private static func firstModel(in root: URL) -> URL? {
        allFiles(in: root).first { modelExtensions.contains($0.pathExtension.lowercased()) }
    }

    private static func firstNavigation(in root: URL) -> URL? {
        let preferred = Set(["nav.txt", "navigation.txt", "scene-nav.txt"])
        let files = allFiles(in: root)
        if let match = files.first(where: { preferred.contains($0.lastPathComponent.lowercased()) }) {
            return match
        }
        return files.first { $0.pathExtension.lowercased() == "txt" }
    }

    private static func allFiles(in root: URL) -> [URL] {
        let fm = FileManager.default
        guard let enumerator = fm.enumerator(
            at: root,
            includingPropertiesForKeys: [.isRegularFileKey],
            options: [.skipsHiddenFiles]
        ) else {
            return []
        }
        var result: [URL] = []
        for case let fileURL as URL in enumerator {
            let values = try? fileURL.resourceValues(forKeys: [.isRegularFileKey])
            if values?.isRegularFile == true {
                result.append(fileURL)
            }
        }
        return result
    }

    private static func unzip(_ zipURL: URL, to destination: URL) throws {
        do {
            try SandboxedZipExtractor.extract(zipURL: zipURL, to: destination)
        } catch let error as SandboxedZipExtractor.Error {
            throw LoadError.unzipFailedDetail(error.localizedDescription)
        } catch {
            throw LoadError.unzipFailedDetail(error.localizedDescription)
        }
    }

    static var importContentTypes: [UTType] {
        var types: [UTType] = [
            UTType(filenameExtension: "ply")!,
            UTType(filenameExtension: "splat")!,
            UTType(filenameExtension: "spz")!,
        ]
        if let zip = UTType(filenameExtension: "zip") {
            types.append(zip)
        }
        types.append(.zip)
        return types
    }
}