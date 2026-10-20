import ArchcarKit
import SwiftUI

struct RootTabView: View {
    enum RootTab: Hashable { case workspaces, chats, more }

    @Environment(AppModel.self) private var model
    @Environment(\.colorScheme) private var systemScheme
    @AppStorage(AppearancePreference.storageKey) private var appearance = AppearancePreference.dark

    private var scheme: ColorScheme { appearance.colorScheme ?? systemScheme }
    private var palette: Palette { scheme == .light ? Theme.light : Theme.dark }

    @State private var selection = RootTab.workspaces
    @State private var showMissingChat = false

    var body: some View {
        // Three tabs, not four: Review used to be a placeholder promising the
        // panels that now live inside a workspace, which is where the desktop
        // keeps them too.
        TabView(selection: $selection) {
            WorkspacesView()
                .tabItem { Label("Workspaces", systemImage: "square.stack.3d.up") }
                .tag(RootTab.workspaces)
            ChatsTabView()
                .tabItem { Label("Chats", systemImage: "bubble.left.and.bubble.right") }
                .tag(RootTab.chats)
            DaemonsView()
                .tabItem { Label("More", systemImage: "ellipsis.circle") }
                .tag(RootTab.more)
        }
        // A tapped notification lands on the Chats tab, which pushes the chat
        // and clears the request. A chat that no longer exists gets an alert
        // here, whichever tab is showing, and nothing is pushed.
        .onChange(of: model.chatOpenRequest, initial: true) { _, request in
            switch request {
            case .found:
                selection = .chats
            case .notFound:
                showMissingChat = true
                model.clearChatOpenRequest()
            case nil:
                break
            }
        }
        .alert("Chat not found", isPresented: $showMissingChat) {
            Button("OK", role: .cancel) {}
        } message: {
            Text("That chat is no longer available. It may have been deleted.")
        }
        .environment(\.palette, palette)
        .tint(palette.accent)
        .preferredColorScheme(appearance.colorScheme)
    }
}
