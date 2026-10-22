import Foundation

extension Notification.Name {
    static let measurementDisplayPreferenceDidChange = Notification.Name(
        "measurementDisplayPreferenceDidChange"
    )
}

/// Local preference for Measure tool label formatting.
enum MeasurementDisplayPreferences {
    private static let showExactKey = "showExactMeasurements"

    /// When `false` (default), distances round to the nearest 1/4 inch.
    /// When `true`, show finer exact fractions (1/32").
    static var showExactMeasurements: Bool {
        get { UserDefaults.standard.bool(forKey: showExactKey) }
        set {
            UserDefaults.standard.set(newValue, forKey: showExactKey)
            NotificationCenter.default.post(name: .measurementDisplayPreferenceDidChange, object: nil)
        }
    }
}
