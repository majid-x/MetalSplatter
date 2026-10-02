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
            return try loadLooseModel(url)
        }
        throw LoadError.unsupportedType
    }

    /// Bare .ply / .splat / .spz — also pick up a sibling `nav.txt` in the same folder when present.
    private static func loadLooseModel(_ url: URL) throws -> Contents {
        let navigation: SceneNavigationData?
        if let navURL = siblingNavigation(nextTo: url) {
            let text = try String(contentsOf: navURL, encoding: .utf8)
            do {
                navigation = try SceneNavigationData.parse(text)
            } catch {
                throw LoadError.invalidNavigation(error.localizedDescription)
            }
        } else {
            navigation = nil
        }
        return Contents(modelURL: url, navigation: navigation)
    }

    private static func siblingNavigation(nextTo modelURL: URL) -> URL? {
        let folder = modelURL.deletingLastPathComponent()
        let preferred = ["nav.txt", "navigation.txt", "scene-nav.txt"]
        let fm = FileManager.default
        for name in preferred {
            let candidate = folder.appendingPathComponent(name)
            if fm.fileExists(atPath: candidate.path) {
                return candidate
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