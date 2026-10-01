import SwiftUI

@main
struct MacAppApp: App {
#if os(iOS)
    @UIApplicationDelegateAdaptor(MacAppOrientationDelegate.self) private var orientationDelegate
#endif
    @State private var authManager = AuthManager()

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environment(authManager)
        }
#if os(macOS) || os(visionOS)
        .defaultSize(width: 1280, height: 820)
#endif
    }
}
