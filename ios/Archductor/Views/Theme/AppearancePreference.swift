import SwiftUI

/// Dark, light, or whatever the phone is doing.
///
/// The desktop treats appearance as an app preference with a `dark` default
/// rather than following the OS (`prefsStore` in `desktop/src/store/prefs.ts`),
/// so the phone does the same. An Archductor that opens white because the phone
/// is in light mode is not the same product.
enum AppearancePreference: String, CaseIterable, Identifiable {
    case dark
    case light
    case system

    var id: String { rawValue }

    var label: String {
        switch self {
        case .dark: "Dark"
        case .light: "Light"
        case .system: "System"
        }
    }

    /// `nil` means "do not override", which is what `system` is.
    var colorScheme: ColorScheme? {
        switch self {
        case .dark: .dark
        case .light: .light
        case .system: nil
        }
    }

    static let storageKey = "archductor.appearance"
}
