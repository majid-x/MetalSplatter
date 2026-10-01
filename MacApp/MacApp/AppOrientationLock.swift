import SwiftUI

#if os(iOS)
import UIKit

enum AppOrientationLock {
    // Read from UIKit orientation callbacks; always mutated on the main actor.
    nonisolated(unsafe) private(set) static var mask: UIInterfaceOrientationMask = .all

    @MainActor
    static func lockLandscape() {
        mask = .landscape
        apply(preferred: .landscape)
    }

    @MainActor
    static func unlockAll() {
        mask = .all
        apply(preferred: .all)
    }

    @MainActor
    private static func apply(preferred: UIInterfaceOrientationMask) {
        guard let scene = UIApplication.shared.connectedScenes
            .compactMap({ $0 as? UIWindowScene })
            .first(where: { $0.activationState == .foregroundActive })
                ?? UIApplication.shared.connectedScenes.compactMap({ $0 as? UIWindowScene }).first
        else { return }

        scene.requestGeometryUpdate(.iOS(interfaceOrientations: preferred))
        UIViewController.attemptRotationToDeviceOrientation()
    }
}

final class MacAppOrientationDelegate: NSObject, UIApplicationDelegate {
    func application(
        _ application: UIApplication,
        supportedInterfaceOrientationsFor window: UIWindow?
    ) -> UIInterfaceOrientationMask {
        AppOrientationLock.mask
    }
}
#endif
