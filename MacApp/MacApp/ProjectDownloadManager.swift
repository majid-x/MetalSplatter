import Foundation
import Observation

/// App-wide project package downloads: survive leaving the viewer, expose card progress, stop.
@Observable
@MainActor
final class ProjectDownloadManager {
    enum Status: Equatable {
        case idle
        case downloading(ProjectDownloadStore.Progress)
        case failed(String)
    }

    private(set) var statuses: [UUID: Status] = [:]

    private struct Waiter {
        let id: UUID
        let continuation: CheckedContinuation<URL, Error>
    }

    private var waiters: [UUID: [Waiter]] = [:]
    private var knownProjects: [UUID: RemoteProject] = [:]
    private var isBound = false

    static let shared = ProjectDownloadManager()

    private init() {
        bindDownloader()
        reattachActiveTasks()
    }

    func status(for projectID: UUID) -> Status {
        statuses[projectID] ?? .idle
    }

    /// Starts a download without waiting. Safe if already downloading.
    func startDownload(for project: RemoteProject) {
        knownProjects[project.id] = project
        if ProjectDownloadStore.hasCachedPackage(for: project) {
            statuses[project.id] = nil
            return
        }
        if BackgroundPackageDownloader.shared.hasActiveDownload(projectID: project.id) {
            return
        }

        let seedProgress = ProjectDownloadStore.loadSavedProgress(for: project.id)
            ?? ProjectDownloadStore.Progress(receivedBytes: 0, totalBytes: nil)

        statuses[project.id] = .downloading(seedProgress)
        ProjectDownloadStore.savePendingDownload(project: project)
        BackgroundPackageDownloader.shared.start(
            projectID: project.id,
            remoteURL: project.remoteURL
        )
    }

    /// Stops an in-flight download and discards partial progress.
    func stop(projectID: UUID) {
        BackgroundPackageDownloader.shared.cancel(projectID: projectID)
        ProjectDownloadStore.clearDownloadArtifacts(for: projectID)
        statuses[projectID] = nil
        failWaiters(projectID: projectID, error: CancellationError())
    }

    /// Waits for a local package. Download keeps going if the waiting view goes away.
    func localPackage(for project: RemoteProject, forceRedownload: Bool = false) async throws -> URL {
        knownProjects[project.id] = project

        if forceRedownload {
            stop(projectID: project.id)
            ProjectDownloadStore.removeCachedPackage(for: project.id)
        }

        if let existing = try? ProjectDownloadStore.packageFileURL(for: project),
           FileManager.default.fileExists(atPath: existing.path),
           ((try? existing.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0) > 0 {
            statuses[project.id] = nil
            return existing
        }

        startDownload(for: project)

        let waiterID = UUID()
        return try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<URL, Error>) in
                waiters[project.id, default: []].append(Waiter(id: waiterID, continuation: continuation))
            }
        } onCancel: {
            Task { @MainActor in
                guard let index = self.waiters[project.id]?.firstIndex(where: { $0.id == waiterID }) else {
                    return
                }
                let waiter = self.waiters[project.id]?.remove(at: index)
                waiter?.continuation.resume(throwing: CancellationError())
            }
        }
    }

    // MARK: - Downloader binding

    private func bindDownloader() {
        guard !isBound else { return }
        isBound = true

        BackgroundPackageDownloader.shared.onProgress = { [weak self] projectID, progress in
            Task { @MainActor in
                guard let self else { return }
                self.statuses[projectID] = .downloading(progress)
                ProjectDownloadStore.saveProgress(progress, for: projectID)
            }
        }

        BackgroundPackageDownloader.shared.onFinished = { [weak self] projectID, result in
            Task { @MainActor in
                await self?.handleFinished(projectID: projectID, result: result)
            }
        }
    }

    private func handleFinished(projectID: UUID, result: Result<URL, Error>) async {
        switch result {
        case .success(let tempURL):
            do {
                guard let project = knownProjects[projectID]
                        ?? ProjectDownloadStore.loadPendingProject(id: projectID) else {
                    try? FileManager.default.removeItem(at: tempURL)
                    statuses[projectID] = .failed("Couldn't finish download.")
                    failWaiters(projectID: projectID, error: ProjectDownloadStore.DownloadError.cannotCreateStore)
                    return
                }

                let localURL = try ProjectDownloadStore.installDownloadedPackage(
                    from: tempURL,
                    for: project
                )
                ProjectDownloadStore.clearDownloadArtifacts(for: projectID)
                statuses[projectID] = nil
                succeedWaiters(projectID: projectID, url: localURL)
            } catch {
                statuses[projectID] = .failed(Self.friendlyMessage(for: error))
                failWaiters(projectID: projectID, error: error)
            }

        case .failure(let error):
            if Self.isCancellation(error) {
                // Stop already cleared status / waiters.
                if statuses[projectID] == nil { return }
            }
            let message = Self.friendlyMessage(for: error)
            statuses[projectID] = .failed(message)
            failWaiters(projectID: projectID, error: error)
        }
    }

    private func succeedWaiters(projectID: UUID, url: URL) {
        let pending = waiters.removeValue(forKey: projectID) ?? []
        for waiter in pending {
            waiter.continuation.resume(returning: url)
        }
    }

    private func failWaiters(projectID: UUID, error: Error) {
        let pending = waiters.removeValue(forKey: projectID) ?? []
        for waiter in pending {
            waiter.continuation.resume(throwing: error)
        }
    }

    private func reattachActiveTasks() {
        BackgroundPackageDownloader.shared.reconnectOutstandingTasks { [weak self] projectID in
            Task { @MainActor in
                guard let self else { return }
                let progress = ProjectDownloadStore.loadSavedProgress(for: projectID)
                    ?? ProjectDownloadStore.Progress(receivedBytes: 0, totalBytes: nil)
                self.statuses[projectID] = .downloading(progress)
            }
        }
    }

    private static func isCancellation(_ error: Error) -> Bool {
        if error is CancellationError { return true }
        let ns = error as NSError
        return ns.domain == NSURLErrorDomain && ns.code == NSURLErrorCancelled
    }

    private static func friendlyMessage(for error: Error) -> String {
        if let localized = error as? LocalizedError, let description = localized.errorDescription {
            return description
        }
        let text = error.localizedDescription
        if text.localizedCaseInsensitiveContains("network")
            || text.localizedCaseInsensitiveContains("internet")
            || text.localizedCaseInsensitiveContains("offline")
            || text.localizedCaseInsensitiveContains("timed out") {
            return "Check your connection and try again."
        }
        return "Something went wrong while downloading. Please try again."
    }
}
