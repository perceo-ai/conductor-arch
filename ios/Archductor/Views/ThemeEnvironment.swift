import ArchcarKit
import SwiftUI

/// Bridges the generated desktop tokens into SwiftUI.
///
/// Colours come from the desktop's *computed* values, so a surface here is the
/// same colour as the same surface there rather than an approximation of it.
extension Color {
    init(components: ColorComponents) {
        self.init(
            .sRGB, red: components.red, green: components.green,
            blue: components.blue, opacity: components.alpha)
    }

    /// Looks a token up in the palette for the current colour scheme.
    static func token(_ name: String, scheme: ColorScheme) -> Color? {
        let palette = scheme == .light ? Theme.light : Theme.dark
        return palette.color(name).map(Color.init(components:))
    }
}

extension WorkspaceStatusKind {
    var swiftUIColor: Color { Color(components: color) }
}

/// Makes the palette available to views without threading it through every
/// initialiser.
struct PaletteKey: EnvironmentKey {
    static let defaultValue = Theme.dark
}

extension EnvironmentValues {
    var palette: Palette {
        get { self[PaletteKey.self] }
        set { self[PaletteKey.self] = newValue }
    }
}
