import SwiftUI

@main
struct MacAppApp: App {
    @State private var authManager = AuthManager()

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environment(authManager)
        }
        .defaultSize(width: 1280, height: 820)
    }
}
