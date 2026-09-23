import ArchcarKit
import SwiftUI

/// The desktop's design tokens, named.
///
/// `Palette` is a string-keyed bag because it is generated from CSS. Views
/// should not carry `"--lc-surface-raised"` around, and a typo in one should
/// not silently render clear, so every token the phone uses is resolved here
/// once with a deliberate fallback.
extension Palette {
    private func color(_ name: String, fallback: Color) -> Color {
        color(name).map(Color.init(components:)) ?? fallback
    }

    /// The window behind everything.
    var bg: Color { color("--lc-bg", fallback: .black) }
    /// A panel sitting on the background.
    var surface: Color { color("--lc-surface", fallback: .black) }
    /// A panel sitting on a panel — rows, cards, the composer.
    var surfaceRaised: Color { color("--lc-surface-raised", fallback: .black) }
    /// Pressed, selected, or hovered.
    var surfaceSelected: Color { color("--lc-hover", fallback: .gray) }

    var text: Color { color("--lc-text", fallback: .primary) }
    var textStrong: Color { color("--lc-text-strong", fallback: .primary) }
    var textMuted: Color { color("--lc-text-muted", fallback: .secondary) }

    var accent: Color { color("--lc-accent", fallback: .orange) }
    var accentOn: Color { color("--lc-accent-fg", fallback: .white) }
    var accentWash: Color { color("--accent-wash", fallback: .orange.opacity(0.14)) }
    var accentEdge: Color { color("--accent-edge", fallback: .orange.opacity(0.42)) }

    var border: Color { color("--ui-border", fallback: .white.opacity(0.07)) }
    var borderStrong: Color { color("--ui-border-strong", fallback: .white.opacity(0.12)) }

    var danger: Color { color("--lc-danger", fallback: .red) }
    var warning: Color { color("--lc-warning", fallback: .yellow) }

    /// The four tint pairs the desktop uses for chips and inline status.
    func tint(_ kind: TintKind) -> (fill: Color, ink: Color) {
        switch kind {
        case .positive: (color("--tint-pos", fallback: .green.opacity(0.14)), color("--tint-pos-fg", fallback: .green))
        case .negative: (color("--tint-neg", fallback: .red.opacity(0.14)), color("--tint-neg-fg", fallback: .red))
        case .warning: (color("--tint-warn", fallback: .yellow.opacity(0.14)), color("--tint-warn-fg", fallback: .yellow))
        case .info: (color("--tint-info", fallback: .white.opacity(0.07)), color("--tint-info-fg", fallback: .secondary))
        }
    }

    var codeSurface: Color { color("--code-surface", fallback: .black) }
    var codeText: Color { color("--code-fg", fallback: .primary) }
    var diffAdd: Color { color("--diff-add-accent", fallback: .green) }
    var diffDelete: Color { color("--diff-del-accent", fallback: .red) }
    var diffAddBackground: Color { color("--diff-add-bg", fallback: .green.opacity(0.1)) }
    var diffDeleteBackground: Color { color("--diff-del-bg", fallback: .red.opacity(0.1)) }
}

enum TintKind { case positive, negative, warning, info }

/// Radii and insets, straight off `--r-*` and `--ui-*`.
enum Metrics {
    static let radiusSmall: CGFloat = 7
    static let radiusMedium: CGFloat = 10
    static let radiusLarge: CGFloat = 14
    /// The desktop's `--page-inset`, pulled in for a phone's narrower column.
    static let pageInset: CGFloat = 14
    static let rowInset: CGFloat = 12
    static let hairline: CGFloat = 1
}

/// The desktop runs a 13px base with a 1.35 line height. Held literally on a
/// phone that is uncomfortable at arm's length, so every step is bumped one
/// point and the *relationships* — the thing that reads as "dense" — are kept.
enum Typeface {
    static let title = Font.system(size: 16, weight: .semibold)
    static let body = Font.system(size: 14)
    static let bodyStrong = Font.system(size: 14, weight: .semibold)
    static let secondary = Font.system(size: 12)
    static let micro = Font.system(size: 11, weight: .medium)
    static let mono = Font.system(size: 12, design: .monospaced)
    static let monoSmall = Font.system(size: 11, design: .monospaced)
    static let code = Font.system(size: 12, design: .monospaced)
}

// MARK: - Surfaces

/// A panel: raised fill, hairline edge, desktop radius.
struct PanelBackground: ViewModifier {
    @Environment(\.palette) private var palette
    var fill: KeyPath<Palette, Color> = \.surfaceRaised
    var radius: CGFloat = Metrics.radiusSmall
    var border: KeyPath<Palette, Color> = \.border

    func body(content: Content) -> some View {
        content
            .background(palette[keyPath: fill], in: RoundedRectangle(cornerRadius: radius, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: radius, style: .continuous)
                    .strokeBorder(palette[keyPath: border], lineWidth: Metrics.hairline))
    }
}

extension View {
    func panel(
        fill: KeyPath<Palette, Color> = \.surfaceRaised,
        radius: CGFloat = Metrics.radiusSmall,
        border: KeyPath<Palette, Color> = \.border
    ) -> some View {
        modifier(PanelBackground(fill: fill, radius: radius, border: border))
    }

    /// Paints the window behind a screen and hides the system list chrome that
    /// would otherwise sit on top of it in its own colour.
    func archductorScreen() -> some View {
        modifier(ScreenBackground())
    }

    /// A `Form`, in the app's colours.
    ///
    /// Forms are kept as forms on the entry screens — pairing, commit, new
    /// workspace — because the system's field behaviour (keyboard avoidance,
    /// focus, AutoFill opt-outs) is worth more there than a bespoke layout. The
    /// chrome is what gets replaced, not the control.
    func archductorForm() -> some View {
        modifier(FormChrome())
    }
}

struct FormChrome: ViewModifier {
    @Environment(\.palette) private var palette

    func body(content: Content) -> some View {
        content
            .scrollContentBackground(.hidden)
            .background(palette.bg.ignoresSafeArea())
            .tint(palette.accent)
            .foregroundStyle(palette.text)
    }
}

struct ScreenBackground: ViewModifier {
    @Environment(\.palette) private var palette

    func body(content: Content) -> some View {
        content
            .scrollContentBackground(.hidden)
            // The tab bar is opaque here, not the system's translucent
            // material, so content scrolling under it is hidden rather than
            // dimmed. The margin is what keeps the last row reachable.
            .contentMargins(.bottom, 28, for: .scrollContent)
            .background(palette.bg.ignoresSafeArea())
    }
}

// MARK: - Components

/// The desktop's pill chip: tinted fill, no border, micro type.
struct TintChip: View {
    @Environment(\.palette) private var palette
    let text: String
    var systemImage: String?
    var kind: TintKind = .info

    var body: some View {
        let tint = palette.tint(kind)
        HStack(spacing: 3) {
            if let systemImage { Image(systemName: systemImage).imageScale(.small) }
            Text(text)
        }
        .font(Typeface.micro)
        .foregroundStyle(tint.ink)
        .padding(.horizontal, 6)
        .padding(.vertical, 2)
        .background(tint.fill, in: Capsule())
    }
}

/// A gold-filled primary action. Used once per screen, the way the desktop
/// spends its accent.
struct AccentButtonStyle: ButtonStyle {
    @Environment(\.palette) private var palette
    @Environment(\.isEnabled) private var isEnabled

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(Typeface.bodyStrong)
            .foregroundStyle(palette.accentOn)
            .padding(.horizontal, 14)
            .padding(.vertical, 8)
            .background(palette.accent, in: RoundedRectangle(cornerRadius: Metrics.radiusSmall, style: .continuous))
            .opacity(isEnabled ? (configuration.isPressed ? 0.82 : 1) : 0.4)
    }
}

/// A bordered, unfilled action — the desktop's default control.
struct QuietButtonStyle: ButtonStyle {
    @Environment(\.palette) private var palette
    @Environment(\.isEnabled) private var isEnabled

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(Typeface.body)
            .foregroundStyle(palette.text)
            .padding(.horizontal, 12)
            .padding(.vertical, 7)
            .background(
                configuration.isPressed ? palette.surfaceSelected : palette.surfaceRaised,
                in: RoundedRectangle(cornerRadius: Metrics.radiusSmall, style: .continuous)
            )
            .overlay(
                RoundedRectangle(cornerRadius: Metrics.radiusSmall, style: .continuous)
                    .strokeBorder(palette.border, lineWidth: Metrics.hairline)
            )
            .opacity(isEnabled ? 1 : 0.4)
    }
}

/// The status dot from the workspace rows, at the desktop's 8px.
struct StatusDot: View {
    let status: WorkspaceStatusKind
    var size: CGFloat = 8

    var body: some View {
        Circle()
            .fill(status.swiftUIColor)
            .frame(width: size, height: size)
            .accessibilityLabel(status.label)
    }
}

/// A section heading in the desktop's voice: small, muted, letter-spaced.
struct SectionHeading: View {
    @Environment(\.palette) private var palette
    let text: String
    var trailing: String?

    var body: some View {
        HStack {
            Text(text.uppercased())
                .font(.system(size: 10, weight: .semibold))
                .tracking(0.6)
                .foregroundStyle(palette.textMuted)
            Spacer()
            if let trailing {
                Text(trailing)
                    .font(Typeface.micro)
                    .foregroundStyle(palette.textMuted)
            }
        }
        .padding(.horizontal, 2)
    }
}

/// An empty state that does not hand the screen back to the system's styling.
struct EmptyStateView: View {
    @Environment(\.palette) private var palette
    let title: String
    let systemImage: String
    let detail: String
    var action: (label: String, run: () -> Void)?

    var body: some View {
        VStack(spacing: 10) {
            Image(systemName: systemImage)
                .font(.system(size: 26, weight: .light))
                .foregroundStyle(palette.textMuted)
            Text(title)
                .font(Typeface.title)
                .foregroundStyle(palette.textStrong)
            Text(detail)
                .font(Typeface.secondary)
                .foregroundStyle(palette.textMuted)
                .multilineTextAlignment(.center)
                .frame(maxWidth: 280)
            if let action {
                Button(action.label, action: action.run)
                    .buttonStyle(QuietButtonStyle())
                    .padding(.top, 2)
            }
        }
        .padding(24)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(palette.bg)
    }
}
