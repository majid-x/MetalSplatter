import Foundation

/// Downloads remote scene packages into the app's private Application Support store.
/// Files live under the app bundle identifier and are excluded from backups; they are
/// not placed in Documents/Downloads (user-visible folders).
enum ProjectDownloadStore {
    enum DownloadError: LocalizedError {
        case cannotCreateStore
        case invalidResponse
        case downloadFailed(statusCode: Int)
        case emptyDownload

        var errorDescription: String? {
            switch self {
            case .cannotCreateStore:
                return "Couldn't prepare storage for this project."
            case .invalidResponse:
                return "Couldn't reach the project server. Check your connection and try again."
            case .downloadFailed(let code):
                if code == 404 {
                    return "This project isn't available anymore."
                }
                if (500..<600).contains(code) {
                    return "The project server had a problem. Please try again in a moment."
                }
                return "Couldn't download the project. Check your connection and try again."
            case .emptyDownload:
                return "The downloaded project was empty. Please try again."
            }
        }
    }

    struct Progress: Sendable, Equatable {
        /// Bytes written so far.
        var receivedBytes: Int64
        /// Total size from Content-Length when known; `nil` if the server omitted it.
        var totalBytes: Int64?

        var fraction: Double? {
            guard let totalBytes, totalBytes > 0 else { return nil }
            return min(1, Double(receivedBytes) / Double(totalBytes))
        }
    }

    private static let storeFolderName = "PrivateProjects"

    /// Root: `~/Library/Application Support/<bundleID>/PrivateProjects/`
    static var rootDirectory: URL {
        get throws {
            let fm = FileManager.default
            let appSupport = try fm.url(
                for: .applicationSupportDirectory,
                in: .userDomainMask,
                appropriateFor: nil,
                create: true
            )
            let bundleID = Bundle.main.bundleIdentifier ?? "com.metalsplatter.vroomktest"
            let root = appSupport
                .appendingPathComponent(bundleID, isDirectory: true)
                .appendingPathComponent(storeFolderName, isDirectory: true)
            try ensurePrivateDirectory(root)
            return root
        }
    }

    static func projectDirectory(for projectID: UUID) throws -> URL {
        let dir = try rootDirectory.appendingPathComponent(projectID.uuidString, isDirectory: true)
        try ensurePrivateDirectory(dir)
        return dir
    }

    /// Local package path for a project (downloaded lazily on open).
    static func packageFileURL(for project: RemoteProject) throws -> URL {
        let ext = preferredExtension(for: project.remoteURL)
        return try projectDirectory(for: project.id).appendingPathComponent("package.\(ext)")
    }

    /// Where ScenePackageLoader should unpack this project's zip (ignored for loose model files).
    static func extractDirectory(for projectID: UUID) throws -> URL {
        let dir = try projectDirectory(for: projectID).appendingPathComponent("scene", isDirectory: true)
        try ensurePrivateDirectory(dir)
        return dir
    }

    static func hasCachedPackage(for project: RemoteProject) -> Bool {
        guard let file = try? packageFileURL(for: project) else { return false }
        return FileManager.default.fileExists(atPath: file.path)
    }

    /// Downloads `remoteURL` into private storage if needed. Returns the local package URL.
    @discardableResult
    static func ensureLocalPackage(
        for project: RemoteProject,
        onProgress: (@Sendable (Progress) -> Void)? = nil
    ) async throws -> URL {
        let localURL = try packageFileURL(for: project)
        if FileManager.default.fileExists(atPath: localURL.path) {
            let size = (try? localURL.resourceValues(forKeys: [URLResourceKey.fileSizeKey]).fileSize) ?? 0
            if size > 0 {
                let total = Int64(size)
                onProgress?(Progress(receivedBytes: total, totalBytes: total))
                return localURL
            }
            try? FileManager.default.removeItem(at: localURL)
        }

        let tempURL = try await download(
            from: project.remoteURL,
            onProgress: onProgress
        )

        let fm = FileManager.default
        if fm.fileExists(atPath: localURL.path) {
            try fm.removeItem(at: localURL)
        }
        try fm.moveItem(at: tempURL, to: localURL)
        try lockDownFile(at: localURL)

        let size = (try? localURL.resourceValues(forKeys: [URLResourceKey.fileSizeKey]).fileSize) ?? 0
        guard size > 0 else {
            try? fm.removeItem(at: localURL)
            throw DownloadError.emptyDownload
        }
        return localURL
    }

    /// Removes one project's private cache (package + extracted scene).
    static func removeCachedPackage(for projectID: UUID) {
        guard let dir = try? projectDirectory(for: projectID) else { return }
        try? FileManager.default.removeItem(at: dir)
    }

    // MARK: - Download with progress

    private static func download(
        from remoteURL: URL,
        onProgress: (@Sendable (Progress) -> Void)?
    ) async throws -> URL {
        try await withCheckedThrowingContinuation { continuation in
            let delegate = DownloadDelegate(
                continuation: continuation,
                onProgress: onProgress
            )
            let session = URLSession(
                configuration: .default,
                delegate: delegate,
                delegateQueue: nil
            )
            delegate.retainSession(session)
            session.downloadTask(with: remoteURL).resume()
        }
    }

    private final class DownloadDelegate: NSObject, URLSessionDownloadDelegate, @unchecked Sendable {
        private let continuation: CheckedContinuation<URL, Error>
        private let onProgress: (@Sendable (Progress) -> Void)?
        private var session: URLSession?
        private var didFinish = false

        init(
            continuation: CheckedContinuation<URL, Error>,
            onProgress: (@Sendable (Progress) -> Void)?
        ) {
            self.continuation = continuation
            self.onProgress = onProgress
        }

        func retainSession(_ session: URLSession) {
            self.session = session
        }

        func urlSession(
            _ session: URLSession,
            downloadTask: URLSessionDownloadTask,
            didWriteData bytesWritten: Int64,
            totalBytesWritten: Int64,
            totalBytesExpectedToWrite: Int64
        ) {
            let total: Int64? = totalBytesExpectedToWrite > 0 ? totalBytesExpectedToWrite : nil
            onProgress?(Progress(receivedBytes: totalBytesWritten, totalBytes: total))
        }

        func urlSession(
            _ session: URLSession,
            downloadTask: URLSessionDownloadTask,
            didFinishDownloadingTo location: URL
        ) {
            guard !didFinish else { return }

            if let http = downloadTask.response as? HTTPURLResponse,
               !(200..<300).contains(http.statusCode) {
                didFinish = true
                continuation.resume(throwing: DownloadError.downloadFailed(statusCode: http.statusCode))
                finishSession()
                return
            }

            guard downloadTask.response is HTTPURLResponse else {
                didFinish = true
                continuation.resume(throwing: DownloadError.invalidResponse)
                finishSession()
                return
            }

            let tempDir = FileManager.default.temporaryDirectory
            let dest = tempDir.appendingPathComponent("vroomk-dl-\(UUID().uuidString)")
            do {
                if FileManager.default.fileExists(atPath: dest.path) {
                    try FileManager.default.removeItem(at: dest)
                }
                try FileManager.default.copyItem(at: location, to: dest)
                didFinish = true
                continuation.resume(returning: dest)
            } catch {
                didFinish = true
                continuation.resume(throwing: error)
            }
            finishSession()
        }

        func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: (any Error)?) {
            guard let error, !didFinish else { return }
            didFinish = true
            continuation.resume(throwing: error)
            finishSession()
        }

        private func finishSession() {
            session?.finishTasksAndInvalidate()
            session = nil
        }
    }

    private static func preferredExtension(for url: URL) -> String {
        let ext = url.pathExtension.lowercased()
        if ["zip", "ply", "splat", "spz"].contains(ext) {
            return ext
        }
        return "zip"
    }

    // MARK: - Private filesystem hardening

    private static func ensurePrivateDirectory(_ url: URL) throws {
        let fm = FileManager.default
        if !fm.fileExists(atPath: url.path) {
            try fm.createDirectory(at: url, withIntermediateDirectories: true)
        }
        try fm.setAttributes(
            [.posixPermissions: NSNumber(value: 0o700)],
            ofItemAtPath: url.path
        )
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        var mutable = url
        try mutable.setResourceValues(values)
    }

    private static func lockDownFile(at url: URL) throws {
        try FileManager.default.setAttributes(
            [.posixPermissions: NSNumber(value: 0o600)],
            ofItemAtPath: url.path
        )
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        var mutable = url
        try mutable.setResourceValues(values)
    }
}
