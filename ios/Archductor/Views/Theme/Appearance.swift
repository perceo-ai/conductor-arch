import ArchcarKit
import SwiftUI
import UIKit

/// SwiftUI does not reach the bars.
///
/// `TabView` and `NavigationStack` draw through UIKit, and they default to a
/// system-material background that reads as light grey on top of a near-black
/// app. Nothing short of the appearance proxies changes that, so the same
/// generated tokens are pushed into UIKit once at launch.
enum Appearance {
    static func apply() {
        for scheme in [ColorScheme.dark, .light] {
            let palette = scheme == .light ? Theme.light : Theme.dark
            let traits = UITraitCollection(
                userInterfaceStyle: scheme == .light ? .light : .dark)
            apply(palette: palette, for: traits)
        }
    }

    private static func apply(palette: Palette, for traits: UITraitCollection) {
        let background = uiColor(palette, "--lc-bg") ?? .black
        let surface = uiColor(palette, "--lc-surface") ?? background
        let text = uiColor(palette, "--lc-text") ?? .label
        let strong = uiColor(palette, "--lc-text-strong") ?? text
        let muted = uiColor(palette, "--lc-text-muted") ?? .secondaryLabel
        let accent = uiColor(palette, "--lc-accent") ?? .systemOrange
        let border = uiColor(palette, "--ui-border") ?? .separator

        let navigation = UINavigationBarAppearance()
        navigation.configureWithOpaqueBackground()
        navigation.backgroundColor = background
        navigation.shadowColor = border
        navigation.titleTextAttributes = [
            .foregroundColor: strong,
            .font: UIFont.systemFont(ofSize: 16, weight: .semibold),
        ]
        navigation.largeTitleTextAttributes = [
            .foregroundColor: strong,
            .font: UIFont.systemFont(ofSize: 28, weight: .semibold),
        ]
        let navigationProxy = UINavigationBar.appearance(for: traits)
        navigationProxy.standardAppearance = navigation
        navigationProxy.scrollEdgeAppearance = navigation
        navigationProxy.compactAppearance = navigation
        navigationProxy.tintColor = accent

        let tab = UITabBarAppearance()
        tab.configureWithOpaqueBackground()
        tab.backgroundColor = surface
        tab.shadowColor = border
        for item in [tab.stackedLayoutAppearance, tab.inlineLayoutAppearance, tab.compactInlineLayoutAppearance] {
            item.normal.iconColor = muted
            item.normal.titleTextAttributes = [
                .foregroundColor: muted,
                .font: UIFont.systemFont(ofSize: 10, weight: .medium),
            ]
            item.selected.iconColor = accent
            item.selected.titleTextAttributes = [
                .foregroundColor: accent,
                .font: UIFont.systemFont(ofSize: 10, weight: .semibold),
            ]
        }
        let tabProxy = UITabBar.appearance(for: traits)
        tabProxy.standardAppearance = tab
        tabProxy.scrollEdgeAppearance = tab
        // iOS 26's floating tab bar ignores the per-item colours above for the
        // unselected state and falls back to white, which is the one thing on
        // the screen brighter than the titles.
        tabProxy.unselectedItemTintColor = muted
        tabProxy.tintColor = accent

        // Lists and their separators. `scrollContentBackground(.hidden)` covers
        // the table itself; the cells underneath keep their own colour.
        UITableView.appearance(for: traits).backgroundColor = .clear
        UITableViewCell.appearance(for: traits).backgroundColor = .clear
        UICollectionView.appearance(for: traits).backgroundColor = .clear
        UITableView.appearance(for: traits).separatorColor = border

        UITextView.appearance(for: traits).backgroundColor = .clear
        UIRefreshControl.appearance(for: traits).tintColor = muted
    }

    private static func uiColor(_ palette: Palette, _ token: String) -> UIColor? {
        palette.color(token).map { components in
            UIColor(
                red: components.red, green: components.green,
                blue: components.blue, alpha: components.alpha)
        }
    }
}
