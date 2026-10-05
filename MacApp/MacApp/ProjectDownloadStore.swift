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
    private static let progressFileName = "download-progress.json"
    private static let pendingFileName = "download-pending.json"

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

    /// Moves a finished temp download into the project's private package path.
    static func installDownloadedPackage(from tempURL: URL, for project: RemoteProject) throws -> URL {
        let localURL = try packageFileURL(for: project)
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

    /// Removes one project's private cache (package + extracted scene + download artifacts).
    static func removeCachedPackage(for projectID: UUID) {
        guard let dir = try? projectDirectory(for: projectID) else { return }
        try? FileManager.default.removeItem(at: dir)
    }

    /// UUID folder names under PrivateProjects that currently exist on disk.
    static func cachedProjectIDs() -> [UUID] {
        guard let root = try? rootDirectory else { return [] }
        let fm = FileManager.default
        guard let names = try? fm.contentsOfDirectory(atPath: root.path) else { return [] }
        return names.compactMap { UUID(uuidString: $0) }.filter { id in
            var isDir: ObjCBool = false
            let path = root.appendingPathComponent(id.uuidString, isDirectory: true).path
            return fm.fileExists(atPath: path, isDirectory: &isDir) && isDir.boolValue
        }
    }

    /// Total bytes used by all locally cached projects (packages + extracted scenes).
    static func totalCachedBytes() -> Int64 {
        guard let root = try? rootDirectory else { return 0 }
        return directoryByteSize(at: root)
    }

    /// Deletes local project folders whose IDs are not in `keepIDs` (e.g. removed from DB).
    /// Returns the number of project folders removed.
    @discardableResult
    static func removeOrphanedCaches(keeping keepIDs: Set<UUID>) -> Int {
        var removed = 0
        for id in cachedProjectIDs() where !keepIDs.contains(id) {
            removeCachedPackage(for: id)
            removed += 1
        }
        return removed
    }

    // MARK: - In-flight download metadata

    static func saveProgress(_ progress: Progress, for projectID: UUID) {
        guard let dir = try? projectDirectory(for: projectID) else { return }
        let url = dir.appendingPathComponent(progressFileName)
        let payload = ProgressDisk(receivedBytes: progress.receivedBytes, totalBytes: progress.totalBytes)
        guard let data = try? JSONEncoder().encode(payload) else { return }
        try? data.write(to: url, options: .atomic)
    }

    static func loadSavedProgress(for projectID: UUID) -> Progress? {
        guard let dir = try? projectDirectory(for: projectID) else { return nil }
        let url = dir.appendingPathComponent(progressFileName)
        guard let data = try? Data(contentsOf: url),
              let payload = try? JSONDecoder().decode(ProgressDisk.self, from: data) else { return nil }
        return Progress(receivedBytes: payload.receivedBytes, totalBytes: payload.totalBytes)
    }

    static func savePendingDownload(project: RemoteProject) {
        guard let dir = try? projectDirectory(for: project.id) else { return }
        let url = dir.appendingPathComponent(pendingFileName)
        let payload = PendingDisk(
            id: project.id,
            remoteURL: project.remoteURL.absoluteString,
            fileExtension: preferredExtension(for: project.remoteURL)
        )
        guard let data = try? JSONEncoder().encode(payload) else { return }
        try? data.write(to: url, options: .atomic)
    }

    static func loadPendingProject(id: UUID) -> RemoteProject? {
        guard let dir = try? projectDirectory(for: id) else { return nil }
        let url = dir.appendingPathComponent(pendingFileName)
        guard let data = try? Data(contentsOf: url),
              let payload = try? JSONDecoder().decode(PendingDisk.self, from: data),
              let remoteURL = URL(string: payload.remoteURL) else { return nil }
        return RemoteProject(
            id: payload.id,
            userId: UUID(),
            name: "Project",
            remoteURL: remoteURL,
            photoAPIBaseURL: nil,
            isSPZ: false,
            useServerCalibration: false,
            measureFactor: 1,
            moveSpeed: nil,
            createdAt: nil
        )
    }

    static func clearDownloadArtifacts(for projectID: UUID) {
        guard let dir = try? projectDirectory(for: projectID) else { return }
        let fm = FileManager.default
        try? fm.removeItem(at: dir.appendingPathComponent(progressFileName))
        try? fm.removeItem(at: dir.appendingPathComponent(pendingFileName))
        // Leftover from the removed pause/resume feature.
        try? fm.removeItem(at: dir.appendingPathComponent("download.resume"))
    }

    // MARK: - Private

    private struct ProgressDisk: Codable {
        var receivedBytes: Int64
        var totalBytes: Int64?
    }

    private struct PendingDisk: Codable {
        var id: UUID
        var remoteURL: String
        var fileExtension: String
    }

    private static func directoryByteSize(at url: URL) -> Int64 {
        let fm = FileManager.default
        guard let enumerator = fm.enumerator(
            at: url,
            includingPropertiesForKeys: [.isRegularFileKey, .fileSizeKey, .isDirectoryKey],
            options: [.skipsHiddenFiles]
        ) else { return 0 }

        var total: Int64 = 0
        for case let fileURL as URL in enumerator {
            guard let values = try? fileURL.resourceValues(forKeys: [.isRegularFileKey, .fileSizeKey]),
                  values.isRegularFile == true,
                  let size = values.fileSize else { continue }
            total += Int64(size)
        }
        return total
    }

    private static func preferredExtension(for url: URL) -> String {
        let ext = url.pathExtension.lowercased()
        if ["zip", "ply", "splat", "spz"].contains(ext) {
            return ext
        }
        return "zip"
    }

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

// MARK: - Background URLSession

/// Shared background download session so project packages keep transferring while the
/// app is suspended, backgrounded, or the screen is locked.
final class BackgroundPackageDownloader: NSObject, URLSessionDownloadDelegate, @unchecked Sendable {
    static let shared = BackgroundPackageDownloader()

    var onProgress: (@Sendable (UUID, ProjectDownloadStore.Progress) -> Void)?
    var onFinished: (@Sendable (UUID, Result<URL, Error>) -> Void)?

    private struct Active {
        let projectID: UUID
        var task: URLSessionDownloadTask
    }

    private let lock = NSLock()
    private var session: URLSession!
    private var activeByProject: [UUID: Active] = [:]
    private var projectByTaskID: [Int: UUID] = [:]
    private var backgroundCompletionHandler: (() -> Void)?

    private static var sessionIdentifier: String {
        let bundleID = Bundle.main.bundleIdentifier ?? "com.metalsplatter.vroomktest"
        return "\(bundleID).project-package-download"
    }

    private override init() {
        super.init()
        let config = URLSessionConfiguration.background(withIdentifier: Self.sessionIdentifier)
        config.isDiscretionary = false
        config.sessionSendsLaunchEvents = true
        config.allowsCellularAccess = true
        config.allowsExpensiveNetworkAccess = true
        config.allowsConstrainedNetworkAccess = true
        config.waitsForConnectivity = true
        let queue = OperationQueue()
        queue.name = "BackgroundPackageDownloader"
        queue.maxConcurrentOperationCount = 1
        session = URLSession(configuration: config, delegate: self, delegateQueue: queue)
    }

    func setBackgroundCompletionHandler(_ handler: @escaping () -> Void) {
        lock.lock()
        backgroundCompletionHandler = handler
        lock.unlock()
    }

    func reconnectOutstandingTasks(onFound: @escaping @Sendable (UUID) -> Void) {
        session.getAllTasks { [weak self] tasks in
            guard let self else { return }
            for task in tasks {
                guard let downloadTask = task as? URLSessionDownloadTask,
                      let raw = downloadTask.taskDescription,
                      let projectID = UUID(uuidString: raw) else { continue }
                self.lock.lock()
                self.activeByProject[projectID] = Active(projectID: projectID, task: downloadTask)
                self.projectByTaskID[downloadTask.taskIdentifier] = projectID
                self.lock.unlock()
                onFound(projectID)
            }
        }
    }

    func hasActiveDownload(projectID: UUID) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        return activeByProject[projectID] != nil
    }

    func start(projectID: UUID, remoteURL: URL) {
        lock.lock()
        if activeByProject[projectID] != nil {
            lock.unlock()
            return
        }
        lock.unlock()

        let task = session.downloadTask(with: remoteURL)
        task.taskDescription = projectID.uuidString

        lock.lock()
        activeByProject[projectID] = Active(projectID: projectID, task: task)
        projectByTaskID[task.taskIdentifier] = projectID
        lock.unlock()

        task.resume()
    }

    func cancel(projectID: UUID) {
        lock.lock()
        let active = activeByProject.removeValue(forKey: projectID)
        if let active {
            projectByTaskID[active.task.taskIdentifier] = nil
        }
        lock.unlock()
        active?.task.cancel()
    }

    // MARK: URLSessionDownloadDelegate

    func urlSession(
        _ session: URLSession,
        downloadTask: URLSessionDownloadTask,
        didWriteData bytesWritten: Int64,
        totalBytesWritten: Int64,
        totalBytesExpectedToWrite: Int64
    ) {
        lock.lock()
        let projectID = projectByTaskID[downloadTask.taskIdentifier]
        lock.unlock()
        guard let projectID else { return }

        let total: Int64? = totalBytesExpectedToWrite > 0 ? totalBytesExpectedToWrite : nil
        onProgress?(
            projectID,
            ProjectDownloadStore.Progress(receivedBytes: totalBytesWritten, totalBytes: total)
        )
    }

    func urlSession(
        _ session: URLSession,
        downloadTask: URLSessionDownloadTask,
        didFinishDownloadingTo location: URL
    ) {
        lock.lock()
        let projectID = projectByTaskID[downloadTask.taskIdentifier]
        if let projectID {
            activeByProject[projectID] = nil
            projectByTaskID[downloadTask.taskIdentifier] = nil
        }
        lock.unlock()

        guard let projectID else { return }

        if let http = downloadTask.response as? HTTPURLResponse,
           !(200..<300).contains(http.statusCode) {
            onFinished?(
                projectID,
                .failure(ProjectDownloadStore.DownloadError.downloadFailed(statusCode: http.statusCode))
            )
            return
        }

        guard downloadTask.response is HTTPURLResponse else {
            onFinished?(projectID, .failure(ProjectDownloadStore.DownloadError.invalidResponse))
            return
        }

        let tempDir = FileManager.default.temporaryDirectory
        let dest = tempDir.appendingPathComponent("vroomk-dl-\(UUID().uuidString)")
        do {
            if FileManager.default.fileExists(atPath: dest.path) {
                try FileManager.default.removeItem(at: dest)
            }
            try FileManager.default.copyItem(at: location, to: dest)
            onFinished?(projectID, .success(dest))
        } catch {
            onFinished?(projectID, .failure(error))
        }
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: (any Error)?) {
        lock.lock()
        let projectID = projectByTaskID[task.taskIdentifier]
        if let projectID {
            activeByProject[projectID] = nil
            projectByTaskID[task.taskIdentifier] = nil
        }
        lock.unlock()

        guard let projectID, let error else { return }
        onFinished?(projectID, .failure(error))
    }

    func urlSessionDidFinishEvents(forBackgroundURLSession session: URLSession) {
        lock.lock()
        let handler = backgroundCompletionHandler
        backgroundCompletionHandler = nil
        lock.unlock()
        DispatchQueue.main.async {
            handler?()
        }
    }
}
