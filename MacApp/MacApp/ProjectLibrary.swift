import Foundation
import Supabase

@MainActor
@Observable
final class ProjectLibrary {
    private(set) var projects: [RemoteProject] = []
    private(set) var isLoading = false
    private(set) var errorMessage: String?

    private let client = SupabaseConfig.client

    func refresh(userId: UUID) async {
        isLoading = true
        errorMessage = nil
        defer { isLoading = false }

        do {
            let userKey = userId.uuidString.lowercased()
            let rows: [RemoteProject] = try await client
                .from("projects")
                .select("id, user_id, project_name, project_url, photo_api, spz, calibration, measur_factor, created_at")
                .eq("user_id", value: userKey)
                .order("created_at", ascending: false)
                .execute()
                .value
            projects = rows
            // Drop local downloads for projects no longer returned by the DB.
            let keepIDs = Set(rows.map(\.id))
            _ = await Task.detached(priority: .utility) {
                ProjectDownloadStore.removeOrphanedCaches(keeping: keepIDs)
            }.value
        } catch {
            projects = []
            errorMessage = friendlyMessage(for: error)
        }
    }

    func clear() {
        projects = []
        errorMessage = nil
        isLoading = false
    }

    private func friendlyMessage(for error: Error) -> String {
        let text = error.localizedDescription
        if text.localizedCaseInsensitiveContains("offline")
            || text.localizedCaseInsensitiveContains("network")
            || text.localizedCaseInsensitiveContains("internet") {
            return "You're offline. Check your connection and try again."
        }
        if text.localizedCaseInsensitiveContains("unauthorized")
            || text.localizedCaseInsensitiveContains("jwt")
            || text.localizedCaseInsensitiveContains("session") {
            return "Your session expired. Please sign in again."
        }
        return "Couldn't load your projects. Please try again."
    }
}
