import Foundation
import Supabase

/// File-backed auth session storage under Application Support.
/// Avoids macOS Keychain password prompts that appear with the default
/// `KeychainLocalStorage` (especially with ad-hoc / unsigned debug builds).
/// End users will not see Keychain dialogs for session restore.
struct FileAuthLocalStorage: AuthLocalStorage {
    private let directory: URL
    private let lock = NSLock()

    init() {
        let fm = FileManager.default
        let base = (try? fm.url(
            for: .applicationSupportDirectory,
            in: .userDomainMask,
            appropriateFor: nil,
            create: true
        )) ?? fm.temporaryDirectory
        let bundleID = Bundle.main.bundleIdentifier ?? "com.metalsplatter.vroomktest"
        directory = base
            .appendingPathComponent(bundleID, isDirectory: true)
            .appendingPathComponent("AuthSession", isDirectory: true)
        try? fm.createDirectory(at: directory, withIntermediateDirectories: true)
        try? fm.setAttributes(
            [.posixPermissions: NSNumber(value: 0o700)],
            ofItemAtPath: directory.path
        )
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        var mutable = directory
        try? mutable.setResourceValues(values)
    }

    func store(key: String, value: Data) throws {
        lock.lock()
        defer { lock.unlock() }
        try value.write(to: fileURL(for: key), options: [.atomic])
    }

    func retrieve(key: String) throws -> Data? {
        lock.lock()
        defer { lock.unlock() }
        let url = fileURL(for: key)
        guard FileManager.default.fileExists(atPath: url.path) else { return nil }
        return try Data(contentsOf: url)
    }

    func remove(key: String) throws {
        lock.lock()
        defer { lock.unlock() }
        let url = fileURL(for: key)
        if FileManager.default.fileExists(atPath: url.path) {
            try FileManager.default.removeItem(at: url)
        }
    }

    private func fileURL(for key: String) -> URL {
        let safe = key
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: ":", with: "_")
        return directory.appendingPathComponent("\(safe).session")
    }
}
