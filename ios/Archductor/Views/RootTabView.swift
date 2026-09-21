import ArchcarKit
import SwiftUI

struct RootTabView: View {
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        TabView {
            WorkspacesView()
                .tabItem { Label("Workspaces", systemImage: "square.stack.3d.up") }
            ChatsTabView()
                .tabItem { Label("Chats", systemImage: "bubble.left.and.bubble.right") }
            PlaceholderTab(
                title: "Review",
                detail: "Changes, checks, and pull requests land after chat.")
                .tabItem { Label("Review", systemImage: "checklist") }
            DaemonsView()
                .tabItem { Label("More", systemImage: "ellipsis.circle") }
        }
        .environment(\.palette, colorScheme == .light ? Theme.light : Theme.dark)
    }
}

struct PlaceholderTab: View {
    let title: String
    let detail: String

    var body: some View {
        NavigationStack {
            ContentUnavailableView(title, systemImage: "hourglass", description: Text(detail))
                .navigationTitle(title)
        }
    }
}
