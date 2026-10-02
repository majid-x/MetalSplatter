import SwiftUI

private enum DashboardTab: String, CaseIterable, Identifiable {
    case projects = "Projects"
    case settings = "Settings"

    var id: String { rawValue }

    var icon: String {
        switch self {
        case .projects: return "scope"
        case .settings: return "gearshape"
        }
    }
}

struct DashboardView: View {
    @Environment(AuthManager.self) private var authManager
    @Environment(\.horizontalSizeClass) private var sizeClass
    @State private var projectLibrary = ProjectLibrary()

    @State private var selectedTab: DashboardTab = .projects
    @State private var openedProject: RemoteProject?
    @State private var searchText = ""
    @State private var isSearchPresented = false
    /// Bumps when local caches change so cards re-check offline status.
    @State private var localCacheRevision = 0
    /// Total bytes of locally downloaded project packages.
    @State private var localStorageBytes: Int64 = 0

    private var isCompact: Bool { sizeClass == .compact }

    private var localStorageLabel: String {
        ByteCountFormatter.string(fromByteCount: localStorageBytes, countStyle: .file)
    }

    private var firstName: String {
        let name = authManager.displayName
        return name.split(separator: " ").first.map(String.init) ?? name
    }

    private var filteredProjects: [RemoteProject] {
        projectLibrary.projects.filter { project in
            searchText.isEmpty
                || project.name.localizedCaseInsensitiveContains(searchText)
        }
    }

    var body: some View {
        ZStack {
            if let openedProject {
                ProjectViewerView(
                    project: openedProject,
                    onBack: {
                        withAnimation(.easeInOut(duration: 0.25)) {
                            self.openedProject = nil
                        }
                        localCacheRevision += 1
                        refreshLocalStorageUsage()
                    }
                )
                .transition(.opacity)
            } else {
                dashboardChrome
                    .transition(.opacity)
            }
        }
        .background(Color.black)
        .preferredColorScheme(.dark)
        .animation(.easeInOut(duration: 0.25), value: openedProject?.id)
        .sheet(isPresented: $isSearchPresented) {
            searchSheet
        }
        .task(id: authManager.userId) {
            guard let userId = authManager.userId else {
                projectLibrary.clear()
                refreshLocalStorageUsage()
                return
            }
            await projectLibrary.refresh(userId: userId)
            localCacheRevision += 1
            refreshLocalStorageUsage()
        }
    }

    private var dashboardChrome: some View {
        Group {
            if isCompact {
                VStack(spacing: 0) {
                    mainContent
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                    compactTabBar
                }
            } else {
                HStack(spacing: 0) {
                    sidebar
                        .frame(width: 210)

                    mainContent
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                }
            }
        }
    }

    private var compactTabBar: some View {
        HStack(spacing: 0) {
            ForEach(DashboardTab.allCases) { tab in
                Button {
                    withAnimation(.easeOut(duration: 0.2)) {
                        selectedTab = tab
                    }
                } label: {
                    VStack(spacing: 4) {
                        Image(systemName: tab.icon)
                            .font(.system(size: 16, weight: .regular))
                        Text(tab.rawValue)
                            .font(.system(size: 11, weight: selectedTab == tab ? .medium : .regular))
                    }
                    .foregroundStyle(selectedTab == tab ? .white : .white.opacity(0.38))
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 10)
                }
                .buttonStyle(.plain)
            }
        }
        .background(Color.black)
        .overlay(alignment: .top) {
            Rectangle()
                .fill(.white.opacity(0.08))
                .frame(height: 1)
        }
    }

    private var sidebar: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 10) {
                BrandMark()
                    .frame(width: 28, height: 28)
                Text("Vroomk")
                    .font(.system(size: 18, weight: .medium))
                    .foregroundStyle(.white)
            }
            .padding(.horizontal, 22)
            .padding(.top, 28)
            .padding(.bottom, 36)

            VStack(alignment: .leading, spacing: 6) {
                ForEach(DashboardTab.allCases) { tab in
                    Button {
                        withAnimation(.easeOut(duration: 0.2)) {
                            selectedTab = tab
                        }
                    } label: {
                        HStack(spacing: 12) {
                            Image(systemName: tab.icon)
                                .font(.system(size: 14, weight: .regular))
                                .frame(width: 18)
                            Text(tab.rawValue)
                                .font(.system(size: 14, weight: selectedTab == tab ? .medium : .regular))
                            Spacer()
                        }
                        .foregroundStyle(selectedTab == tab ? .white : .white.opacity(0.38))
                        .padding(.horizontal, 14)
                        .padding(.vertical, 10)
                        .background {
                            if selectedTab == tab {
                                RoundedRectangle(cornerRadius: 10, style: .continuous)
                                    .fill(.white.opacity(0.06))
                            }
                        }
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(.horizontal, 12)

            Spacer()

            HStack(spacing: 12) {
                Circle()
                    .fill(.white.opacity(0.08))
                    .frame(width: 36, height: 36)
                    .overlay {
                        Image(systemName: "person.fill")
                            .font(.system(size: 14))
                            .foregroundStyle(.white.opacity(0.7))
                    }

                VStack(alignment: .leading, spacing: 2) {
                    Text(firstName)
                        .font(.system(size: 14, weight: .medium))
                        .foregroundStyle(.white)
                        .lineLimit(1)

                    Menu {
                        Button("Sign Out", role: .destructive) {
                            Task { await authManager.signOut() }
                        }
                    } label: {
                        Text("View Profile")
                            .font(.system(size: 12, weight: .regular))
                            .foregroundStyle(.white.opacity(0.38))
                    }
                    .menuStyle(.automatic)
                    .fixedSize()
                }
            }
            .padding(.horizontal, 22)
            .padding(.bottom, 28)
        }
        .background(Color.black)
    }

    private var mainContent: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 4) {
                Spacer()

                Label(localStorageLabel, systemImage: "internaldrive")
                    .font(.system(size: 12, weight: .regular))
                    .foregroundStyle(.white.opacity(0.55))
                    .padding(.horizontal, 8)
                    .help("Local storage used by downloaded projects")

                Button {
                    isSearchPresented = true
                } label: {
                    Image(systemName: "magnifyingglass")
                        .font(.system(size: 15, weight: .light))
                        .foregroundStyle(.white.opacity(0.75))
                        .frame(width: 32, height: 32)
                }
                .buttonStyle(.plain)

                Button {
                    Task {
                        guard let userId = authManager.userId else { return }
                        await projectLibrary.refresh(userId: userId)
                        localCacheRevision += 1
                        refreshLocalStorageUsage()
                    }
                } label: {
                    Image(systemName: "arrow.clockwise")
                        .font(.system(size: 14, weight: .light))
                        .foregroundStyle(.white.opacity(0.75))
                        .frame(width: 32, height: 32)
                }
                .buttonStyle(.plain)
                .disabled(projectLibrary.isLoading)

                Menu {
                    Button("Sign Out", role: .destructive) {
                        Task { await authManager.signOut() }
                    }
                } label: {
                    Image(systemName: "person.crop.circle")
                        .font(.system(size: 18, weight: .light))
                        .foregroundStyle(.white.opacity(0.75))
                        .frame(width: 32, height: 32)
                }
            }
            .padding(.horizontal, isCompact ? 20 : 36)
            .padding(.top, 22)
            .padding(.bottom, 8)

            switch selectedTab {
            case .projects:
                projectsPane
            case .settings:
                settingsPane
            }
        }
    }

    private var projectsPane: some View {
        VStack(alignment: .leading, spacing: 28) {
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 8) {
                    Text("Projects")
                        .font(.system(size: 40, weight: .ultraLight))
                        .foregroundStyle(.white)

                    Text("Designing spaces, creating better living")
                        .font(.system(size: 14, weight: .regular))
                        .foregroundStyle(.white.opacity(0.42))
                }

                Spacer()
            }
            .padding(.horizontal, isCompact ? 20 : 36)

            Group {
                if projectLibrary.isLoading && projectLibrary.projects.isEmpty {
                    projectsLoadingState
                } else if let error = projectLibrary.errorMessage, projectLibrary.projects.isEmpty {
                    projectsErrorState(error)
                } else if filteredProjects.isEmpty {
                    projectsEmptyState
                } else {
                    projectsGrid
                }
            }
        }
        .padding(.top, 12)
    }

    private var projectColumns: [GridItem] {
        if isCompact {
            return [
                GridItem(.flexible(), spacing: 16),
                GridItem(.flexible(), spacing: 16),
            ]
        }
        return [
            GridItem(.flexible(), spacing: 20),
            GridItem(.flexible(), spacing: 20),
            GridItem(.flexible(), spacing: 20),
            GridItem(.flexible(), spacing: 20),
        ]
    }

    private var projectsGrid: some View {
        ScrollView {
            LazyVGrid(
                columns: projectColumns,
                spacing: isCompact ? 20 : 28
            ) {
                ForEach(filteredProjects) { project in
                    ProjectCardView(
                        project: project,
                        cacheRevision: localCacheRevision,
                        onOpen: {
                            withAnimation(.easeInOut(duration: 0.25)) {
                                openedProject = project
                            }
                        },
                        onDeleteLocal: {
                            ProjectDownloadStore.removeCachedPackage(for: project.id)
                            localCacheRevision += 1
                            refreshLocalStorageUsage()
                        }
                    )
                }
            }
            .padding(.horizontal, isCompact ? 20 : 36)
            .padding(.bottom, isCompact ? 24 : 36)
            .padding(.top, 4)
        }
    }

    private var projectsLoadingState: some View {
        VStack(spacing: 14) {
            ProgressView()
                .controlSize(.regular)
                .tint(.white)
            Text("Loading your projects…")
                .font(.system(size: 14))
                .foregroundStyle(.white.opacity(0.45))
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private func projectsErrorState(_ message: String) -> some View {
        VStack(spacing: 14) {
            Text("Couldn't load projects")
                .font(.system(size: 16, weight: .medium))
                .foregroundStyle(.white)
            Text(message)
                .font(.system(size: 13))
                .foregroundStyle(.white.opacity(0.45))
                .multilineTextAlignment(.center)
                .frame(maxWidth: 420)
            Button("Retry") {
                Task {
                    guard let userId = authManager.userId else { return }
                    await projectLibrary.refresh(userId: userId)
                    localCacheRevision += 1
                    refreshLocalStorageUsage()
                }
            }
            .buttonStyle(.borderedProminent)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .padding(.horizontal, 36)
    }

    private var projectsEmptyState: some View {
        VStack(spacing: 10) {
            Text(searchText.isEmpty ? "No projects yet" : "No matching projects")
                .font(.system(size: 16, weight: .medium))
                .foregroundStyle(.white)
            Text(
                searchText.isEmpty
                    ? "Projects linked to your account will show up here."
                    : "Try a different search."
            )
            .font(.system(size: 13))
            .foregroundStyle(.white.opacity(0.45))

            if searchText.isEmpty {
                Button("Refresh") {
                    Task {
                        guard let userId = authManager.userId else { return }
                        await projectLibrary.refresh(userId: userId)
                        localCacheRevision += 1
                        refreshLocalStorageUsage()
                    }
                }
                .buttonStyle(.borderedProminent)
                .padding(.top, 8)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .padding(.horizontal, 36)
    }

    private var settingsPane: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("Settings")
                .font(.system(size: 40, weight: .ultraLight))
                .foregroundStyle(.white)

            Text("Account preferences will live here.")
                .font(.system(size: 14))
                .foregroundStyle(.white.opacity(0.42))

            Spacer()
        }
        .padding(.horizontal, 36)
        .padding(.top, 12)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }

    private var searchSheet: some View {
        VStack(spacing: 16) {
            Text("Search projects")
                .font(.headline)
            TextField("Search", text: $searchText)
                .textFieldStyle(.roundedBorder)
            Button("Done") { isSearchPresented = false }
                .keyboardShortcut(.defaultAction)
        }
        .padding(24)
        .frame(width: 360)
    }

    private func refreshLocalStorageUsage() {
        localStorageBytes = ProjectDownloadStore.totalCachedBytes()
    }
}

private struct ProjectCardView: View {
    let project: RemoteProject
    var cacheRevision: Int = 0
    var onOpen: () -> Void = {}
    var onDeleteLocal: () -> Void = {}

    private var accent: [Color] {
        ProjectCardView.accent(for: project.id)
    }

    private var isCachedLocally: Bool {
        _ = cacheRevision
        return ProjectDownloadStore.hasCachedPackage(for: project)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            ZStack(alignment: .topTrailing) {
                Button(action: onOpen) {
                    ZStack {
                        LinearGradient(
                            colors: accent,
                            startPoint: .topLeading,
                            endPoint: .bottomTrailing
                        )

                        VStack(spacing: 10) {
                            Image(systemName: isCachedLocally
                                  ? "checkmark.circle"
                                  : "icloud.and.arrow.down")
                                .font(.system(size: 28, weight: .ultraLight))
                                .foregroundStyle(.white.opacity(0.85))
                            Text(isCachedLocally
                                  ? "Ready offline"
                                  : "Cloud project")
                                .font(.system(size: 11, weight: .medium))
                                .foregroundStyle(.white.opacity(0.45))
                        }
                    }
                    .frame(maxWidth: .infinity)
                    .frame(height: 168)
                    .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
                    .overlay {
                        RoundedRectangle(cornerRadius: 16, style: .continuous)
                            .strokeBorder(.white.opacity(0.08), lineWidth: 1)
                    }
                }
                .buttonStyle(.plain)

                Menu {
                    Button("Delete", role: .destructive) {
                        onDeleteLocal()
                    }
                    .disabled(!isCachedLocally)
                } label: {
                    Image(systemName: "chevron.down")
                        .font(.system(size: 11, weight: .semibold))
                        .foregroundStyle(.white.opacity(0.8))
                        .frame(width: 28, height: 28)
                        .background(.black.opacity(0.35), in: Circle())
                        .overlay {
                            Circle()
                                .strokeBorder(.white.opacity(0.12), lineWidth: 1)
                        }
                }
                .menuStyle(.button)
                .menuIndicator(.hidden)
                .buttonStyle(.plain)
                .padding(10)
            }

            Button(action: onOpen) {
                HStack(alignment: .top) {
                    VStack(alignment: .leading, spacing: 4) {
                        Text(project.name)
                            .font(.system(size: 14, weight: .medium))
                            .foregroundStyle(.white)
                            .lineLimit(1)

                        Text(project.categoryLabel)
                            .font(.system(size: 12, weight: .regular))
                            .foregroundStyle(.white.opacity(0.38))
                    }

                    Spacer(minLength: 8)

                    Image(systemName: "arrow.up.right")
                        .font(.system(size: 12, weight: .medium))
                        .foregroundStyle(.white.opacity(0.35))
                        .padding(.top, 2)
                }
                .padding(.horizontal, 2)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
        }
    }

    private static func accent(for id: UUID) -> [Color] {
        let palette: [[Color]] = [
            [Color(red: 0.28, green: 0.36, blue: 0.34), Color(red: 0.10, green: 0.12, blue: 0.11)],
            [Color(red: 0.22, green: 0.30, blue: 0.42), Color(red: 0.08, green: 0.10, blue: 0.16)],
            [Color(red: 0.36, green: 0.28, blue: 0.24), Color(red: 0.12, green: 0.09, blue: 0.08)],
            [Color(red: 0.24, green: 0.32, blue: 0.30), Color(red: 0.07, green: 0.11, blue: 0.12)],
        ]
        let hash = abs(id.uuidString.hashValue)
        return palette[hash % palette.count]
    }
}

#Preview {
    DashboardView()
        .environment(AuthManager())
        .frame(width: 1100, height: 720)
}
