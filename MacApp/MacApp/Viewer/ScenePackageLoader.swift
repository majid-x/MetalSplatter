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
                return "Choose a .zip scene package or a .ply / .splat / .spz file"
            case .unzipFailed:
                return "Could not unzip the scene package"
            case .unzipFailedDetail(let detail):
                return "Could not unzip the scene package: \(detail)"
            case .insufficientDiskSpace(let needed, let available):
                let needMB = max(1, needed / (1024 * 1024))
                let availMB = max(0, available / (1024 * 1024))
                return "Not enough disk space to unpack the scene (need ~\(needMB) MB free, only \(availMB) MB available)"
            case .missingModel:
                return "No .ply / .splat / .spz found in the package"
            case .invalidNavigation(let message):
                return "Invalid nav.txt: \(message)"
            }
        }
    }

    private static let modelExtensions: Set<String> = ["ply", "splat", "spz"]

    static func load(from url: URL) throws -> Contents {
        let ext = url.pathExtension.lowercased()
        if ext == "zip" {
            return try loadZip(url)
        }
        if modelExtensions.contains(ext) {
            let nav = try loadSiblingNavigation(nextTo: url)
            return Contents(modelURL: url, navigation: nav)
        }
        throw LoadError.unsupportedType
    }

    private static func loadSiblingNavigation(nextTo modelURL: URL) throws -> SceneNavigationData? {
        let folder = modelURL.deletingLastPathComponent()
        let candidates = ["nav.txt", "navigation.txt", "scene-nav.txt"]
        for name in candidates {
            let navURL = folder.appendingPathComponent(name)
            guard FileManager.default.fileExists(atPath: navURL.path) else { continue }
            let text = try String(contentsOf: navURL, encoding: .utf8)
            do {
                return try SceneNavigationData.parse(text)
            } catch {
                throw LoadError.invalidNavigation(error.localizedDescription)
            }
        }
        return nil
    }

    private static func loadZip(_ zipURL: URL) throws -> Contents {
        let fm = FileManager.default
        // Prefer Caches over /tmp — same volume usually, but a stable path we can reuse.
        let caches = fm.urls(for: .cachesDirectory, in: .userDomainMask).first
            ?? fm.temporaryDirectory
        let dest = caches
            .appendingPathComponent("MetalSplatterScenes", isDirectory: true)
            .appendingPathComponent(packageCacheKey(for: zipURL), isDirectory: true)

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
#if os(macOS)
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/ditto")
        process.arguments = ["-x", "-k", zipURL.path, destination.path]
        let err = Pipe()
        process.standardError = err
        do {
            try process.run()
        } catch {
            throw LoadError.unzipFailedDetail(error.localizedDescription)
        }
        process.waitUntilExit()
        guard process.terminationStatus == 0 else {
            let data = err.fileHandleForReading.readDataToEndOfFile()
            let message = String(data: data, encoding: .utf8)?
                .trimmingCharacters(in: .whitespacesAndNewlines)
            if let message, !message.isEmpty {
                throw LoadError.unzipFailedDetail(message)
            }
            throw LoadError.unzipFailed
        }
#else
        throw LoadError.unzipFailed
#endif
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