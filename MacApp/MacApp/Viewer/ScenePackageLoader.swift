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
        case missingModel
        case invalidNavigation(String)

        var errorDescription: String? {
            switch self {
            case .unsupportedType:
                return "Choose a .zip scene package or a .ply / .splat / .spz file"
            case .unzipFailed:
                return "Could not unzip the scene package"
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
        let dest = fm.temporaryDirectory
            .appendingPathComponent("MetalSplatterScene-\(UUID().uuidString)", isDirectory: true)
        try fm.createDirectory(at: dest, withIntermediateDirectories: true)

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
        try process.run()
        process.waitUntilExit()
        guard process.terminationStatus == 0 else {
            throw LoadError.unzipFailed
        }
#else
        // iOS: copy zip then use ditto-equivalent via NSFileManager unavailable;
        // fall back to reading sibling-style after manual extract is not available.
        // Use a short Process-free approach: Compression via temporary unzip is not
        // available; require macOS for zip or use folder-of-files on iOS.
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