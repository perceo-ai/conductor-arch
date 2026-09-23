import ArchcarKit
import SwiftUI

struct RootTabView: View {
    @Environment(\.colorScheme) private var systemScheme
    @AppStorage(AppearancePreference.storageKey) private var appearance = AppearancePreference.dark

    private var scheme: ColorScheme { appearance.colorScheme ?? systemScheme }
    private var palette: Palette { scheme == .light ? Theme.light : Theme.dark }

    var body: some View {
        // Three tabs, not four: Review used to be a placeholder promising the
        // panels that now live inside a workspace, which is where the desktop
        // keeps them too.
        TabView {
            WorkspacesView()
                .tabItem { Label("Workspaces", systemImage: "square.stack.3d.up") }
            ChatsTabView()
                .tabItem { Label("Chats", systemImage: "bubble.left.and.bubble.right") }
            DaemonsView()
                .tabItem { Label("More", systemImage: "ellipsis.circle") }
        }
        .environment(\.palette, palette)
        .tint(palette.accent)
        .preferredColorScheme(appearance.colorScheme)
    }
}
