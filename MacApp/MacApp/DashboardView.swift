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

private struct CatalogProject: Identifiable, Hashable {
    let id: String
    let title: String
    let category: String
    let zipResourceName: String
    let accent: [Color]
}

private let catalogProjects: [CatalogProject] = [
    .init(
        id: "hakob-outdoors",
        title: "Hakob Outdoors",
        category: "Residential",
        zipResourceName: "Archive",
        accent: [
            Color(red: 0.28, green: 0.36, blue: 0.34),
            Color(red: 0.10, green: 0.12, blue: 0.11)
        ]
    )
]

struct DashboardView: View {
    @Environment(AuthManager.self) private var authManager

    @State private var selectedTab: DashboardTab = .projects
    @State private var openedProject: CatalogProject?
    @State private var searchText = ""
    @State private var isSearchPresented = false

    private var firstName: String {
        let name = authManager.displayName
        return name.split(separator: " ").first.map(String.init) ?? name
    }

    private var filteredProjects: [CatalogProject] {
        catalogProjects.filter { project in
            searchText.isEmpty
                || project.title.localizedCaseInsensitiveContains(searchText)
                || project.category.localizedCaseInsensitiveContains(searchText)
        }
    }

    var body: some View {
        ZStack {
            if let openedProject {
                ProjectViewerView(
                    title: openedProject.title,
                    zipResourceName: openedProject.zipResourceName,
                    onBack: {
                        withAnimation(.easeInOut(duration: 0.25)) {
                            self.openedProject = nil
                        }
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
    }

    private var dashboardChrome: some View {
        HStack(spacing: 0) {
            sidebar
                .frame(width: 210)

            mainContent
                .frame(maxWidth: .infinity, maxHeight: .infinity)
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
                    .menuStyle(.borderlessButton)
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
            HStack {
                Spacer()
                Button {
                    isSearchPresented = true
                } label: {
                    Image(systemName: "magnifyingglass")
                        .font(.system(size: 15, weight: .light))
                        .foregroundStyle(.white.opacity(0.75))
                        .frame(width: 32, height: 32)
                }
                .buttonStyle(.plain)

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
                .menuStyle(.borderlessButton)
            }
            .padding(.horizontal, 36)
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
            .padding(.horizontal, 36)

            ScrollView {
                LazyVGrid(
                    columns: [
                        GridItem(.flexible(), spacing: 20),
                        GridItem(.flexible(), spacing: 20),
                        GridItem(.flexible(), spacing: 20),
                        GridItem(.flexible(), spacing: 20)
                    ],
                    spacing: 28
                ) {
                    ForEach(filteredProjects) { project in
                        Button {
                            withAnimation(.easeInOut(duration: 0.25)) {
                                openedProject = project
                            }
                        } label: {
                            ProjectCardView(project: project)
                        }
                        .buttonStyle(.plain)
                    }
                }
                .padding(.horizontal, 36)
                .padding(.bottom, 36)
                .padding(.top, 4)
            }
        }
        .padding(.top, 12)
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
}

private struct ProjectCardView: View {
    let project: CatalogProject

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            ZStack {
                LinearGradient(
                    colors: project.accent,
                    startPoint: .topLeading,
                    endPoint: .bottomTrailing
                )

                VStack(spacing: 10) {
                    Image(systemName: "cube.transparent")
                        .font(.system(size: 28, weight: .ultraLight))
                        .foregroundStyle(.white.opacity(0.85))
                    Text("Scene package")
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

            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 4) {
                    Text(project.title)
                        .font(.system(size: 14, weight: .medium))
                        .foregroundStyle(.white)
                        .lineLimit(1)

                    Text(project.category)
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
        }
        .contentShape(Rectangle())
    }
}

#Preview {
    DashboardView()
        .environment(AuthManager())
        .frame(width: 1100, height: 720)
}
