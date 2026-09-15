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

private enum ProjectFilter: String, CaseIterable, Identifiable {
    case all = "All"
    case livingRoom = "Living room"
    case garage = "Garage"

    var id: String { rawValue }
}

private struct DashboardProject: Identifiable {
    let id = UUID()
    let title: String
    let category: String
    let filter: ProjectFilter
    let imageURL: URL
    let accent: [Color]
}

private let dashboardProjects: [DashboardProject] = [
    .init(
        title: "Modern Living",
        category: "Residential",
        filter: .livingRoom,
        imageURL: URL(string: "https://images.unsplash.com/photo-1600210492486-724fe5c67c32?w=800&q=80")!,
        accent: [Color(red: 0.35, green: 0.28, blue: 0.22), Color(red: 0.12, green: 0.10, blue: 0.09)]
    ),
    .init(
        title: "Urban Kitchen",
        category: "Residential",
        filter: .livingRoom,
        imageURL: URL(string: "https://images.unsplash.com/photo-1556912173-46c336c7fd55?w=800&q=80")!,
        accent: [Color(red: 0.22, green: 0.24, blue: 0.26), Color(red: 0.08, green: 0.09, blue: 0.10)]
    ),
    .init(
        title: "Serene Bedroom",
        category: "Residential",
        filter: .livingRoom,
        imageURL: URL(string: "https://images.unsplash.com/photo-1616594039964-ae9021a400a0?w=800&q=80")!,
        accent: [Color(red: 0.28, green: 0.30, blue: 0.34), Color(red: 0.10, green: 0.11, blue: 0.13)]
    ),
    .init(
        title: "Minimal Dining",
        category: "Residential",
        filter: .livingRoom,
        imageURL: URL(string: "https://images.unsplash.com/photo-1617806118233-18e1de36777f?w=800&q=80")!,
        accent: [Color(red: 0.40, green: 0.36, blue: 0.30), Color(red: 0.14, green: 0.12, blue: 0.10)]
    ),
    .init(
        title: "Spa Bathroom",
        category: "Residential",
        filter: .livingRoom,
        imageURL: URL(string: "https://images.unsplash.com/photo-1552321554-5fefe8c9ef14?w=800&q=80")!,
        accent: [Color(red: 0.30, green: 0.34, blue: 0.36), Color(red: 0.11, green: 0.12, blue: 0.13)]
    ),
    .init(
        title: "Work Space",
        category: "Residential",
        filter: .garage,
        imageURL: URL(string: "https://images.unsplash.com/photo-1497366216548-37526070297c?w=800&q=80")!,
        accent: [Color(red: 0.24, green: 0.26, blue: 0.30), Color(red: 0.09, green: 0.10, blue: 0.12)]
    ),
    .init(
        title: "Elegant Entry",
        category: "Residential",
        filter: .livingRoom,
        imageURL: URL(string: "https://images.unsplash.com/photo-1600607687939-ce8a6c25118c?w=800&q=80")!,
        accent: [Color(red: 0.32, green: 0.28, blue: 0.24), Color(red: 0.12, green: 0.10, blue: 0.09)]
    ),
    .init(
        title: "Exterior Facade",
        category: "Residential",
        filter: .garage,
        imageURL: URL(string: "https://images.unsplash.com/photo-1600585154340-be6161a56a0c?w=800&q=80")!,
        accent: [Color(red: 0.26, green: 0.28, blue: 0.30), Color(red: 0.08, green: 0.09, blue: 0.10)]
    )
]

struct DashboardView: View {
    @Environment(AuthManager.self) private var authManager

    @State private var selectedTab: DashboardTab = .projects
    @State private var selectedFilter: ProjectFilter = .all
    @State private var searchText = ""
    @State private var isSearchPresented = false

    private var firstName: String {
        let name = authManager.displayName
        return name.split(separator: " ").first.map(String.init) ?? name
    }

    private var filteredProjects: [DashboardProject] {
        dashboardProjects.filter { project in
            let matchesFilter = selectedFilter == .all || project.filter == selectedFilter
            let matchesSearch = searchText.isEmpty
                || project.title.localizedCaseInsensitiveContains(searchText)
                || project.category.localizedCaseInsensitiveContains(searchText)
            return matchesFilter && matchesSearch
        }
    }

    var body: some View {
        HStack(spacing: 0) {
            sidebar
                .frame(width: 210)

            mainContent
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .background(Color.black)
        .preferredColorScheme(.dark)
        .sheet(isPresented: $isSearchPresented) {
            searchSheet
        }
    }

    // MARK: Sidebar

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

            VStack(alignment: .leading, spacing: 10) {
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
            }
            .padding(.horizontal, 22)
            .padding(.bottom, 28)
        }
        .background(Color.black)
    }

    // MARK: Main

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

                Button {
                    // Placeholder until project creation is wired.
                } label: {
                    Text("New Project +")
                        .font(.system(size: 13, weight: .regular))
                        .foregroundStyle(.white)
                        .padding(.horizontal, 18)
                        .padding(.vertical, 10)
                        .overlay {
                            Capsule()
                                .strokeBorder(.white.opacity(0.55), lineWidth: 1)
                        }
                }
                .buttonStyle(.plain)
                .padding(.top, 8)
            }
            .padding(.horizontal, 36)

            HStack(spacing: 10) {
                ForEach(ProjectFilter.allCases) { filter in
                    Button {
                        withAnimation(.easeOut(duration: 0.2)) {
                            selectedFilter = filter
                        }
                    } label: {
                        Text(filter.rawValue)
                            .font(.system(size: 13, weight: .regular))
                            .foregroundStyle(selectedFilter == filter ? .white : .white.opacity(0.55))
                            .padding(.horizontal, 16)
                            .padding(.vertical, 8)
                            .background {
                                Capsule()
                                    .fill(selectedFilter == filter ? Color.white.opacity(0.12) : .clear)
                                    .overlay {
                                        Capsule()
                                            .strokeBorder(
                                                selectedFilter == filter
                                                    ? Color.clear
                                                    : Color.white.opacity(0.22),
                                                lineWidth: 1
                                            )
                                    }
                            }
                    }
                    .buttonStyle(.plain)
                }
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
                        ProjectCardView(project: project)
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

// MARK: - Card

private struct ProjectCardView: View {
    let project: DashboardProject

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            AsyncImage(url: project.imageURL) { phase in
                switch phase {
                case .success(let image):
                    image
                        .resizable()
                        .scaledToFill()
                case .failure:
                    placeholder
                case .empty:
                    ZStack {
                        placeholder
                        ProgressView()
                            .controlSize(.small)
                            .tint(.white.opacity(0.5))
                    }
                @unknown default:
                    placeholder
                }
            }
            .frame(maxWidth: .infinity)
            .frame(height: 168)
            .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))

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

                Menu {
                    Button("Open") {}
                    Button("Rename") {}
                    Button("Delete", role: .destructive) {}
                } label: {
                    Image(systemName: "ellipsis")
                        .font(.system(size: 13, weight: .medium))
                        .foregroundStyle(.white.opacity(0.45))
                        .frame(width: 24, height: 24)
                        .contentShape(Rectangle())
                }
                .menuStyle(.borderlessButton)
            }
            .padding(.horizontal, 2)
        }
    }

    private var placeholder: some View {
        LinearGradient(
            colors: project.accent,
            startPoint: .topLeading,
            endPoint: .bottomTrailing
        )
    }
}

#Preview {
    DashboardView()
        .environment(AuthManager())
        .frame(width: 1100, height: 720)
}
