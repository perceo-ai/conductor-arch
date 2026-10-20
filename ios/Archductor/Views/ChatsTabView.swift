import ArchcarKit
import SwiftUI

/// Every chat on this daemon, sorted by what needs a human first.
///
/// The ordering is the point of the tab: "who is waiting on me" should be one
/// glance from launch, not a walk through workspaces.
struct ChatsTabView: View {
    @Environment(AppModel.self) private var model
    @State private var path = NavigationPath()

    /// A chat opened by a tapped notification rather than a row.
    struct NotificationRoute: Hashable {
        let workspace: WorkspaceSummary
        let threadID: Int64
    }

    var body: some View {
        NavigationStack(path: $path) {
            Group {
                if let store = model.workspaces {
                    list(store)
                } else {
                    EmptyStateView(
                        title: "Not connected", systemImage: "wifi.slash",
                        detail: "Pair a daemon from the More tab.")
                }
            }
            .archductorScreen()
            .navigationTitle("Chats")
            .navigationBarTitleDisplayMode(.inline)
            .navigationDestination(for: NotificationRoute.self) { route in
                WorkspaceChatEntry(workspace: route.workspace, threadID: route.threadID)
            }
        }
        // `initial` covers a request published before this tab was first
        // built, which is the cold-launch-from-a-tap case.
        .onChange(of: model.chatOpenRequest, initial: true) { _, request in
            guard case .found(let workspace, let threadID) = request else { return }
            // Replace whatever was open, so the tapped chat is one Back away
            // from the list rather than stacked on an unrelated chat.
            path = NavigationPath([NotificationRoute(workspace: workspace, threadID: threadID)])
            model.clearChatOpenRequest()
        }
    }

    private func list(_ store: WorkspacesStore) -> some View {
        ScrollView {
            LazyVStack(spacing: 6) {
                ForEach(rows(store), id: \.id) { row in
                    NavigationLink {
                        WorkspaceChatEntry(workspace: row.workspace, threadID: row.thread.id)
                    } label: {
                        ChatsTabRow(row: row)
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(.horizontal, Metrics.pageInset)
            .padding(.vertical, 14)
        }
        .archductorScreen()
        .refreshable { await store.refresh() }
        .overlay {
            if rows(store).isEmpty {
                EmptyStateView(
                    title: "No chats yet", systemImage: "bubble.left.and.bubble.right",
                    detail: "Open a workspace to start one.")
            }
        }
    }

    struct Row: Identifiable {
        let workspace: WorkspaceSummary
        let thread: ChatThread
        var needsYou: Bool
        var id: Int64 { thread.id }
    }

    private func rows(_ store: WorkspacesStore) -> [Row] {
        let byName = Dictionary(uniqueKeysWithValues: store.workspaces.map { ($0.name, $0) })
        let rows = store.chatThreads.flatMap { workspaceName, threads -> [Row] in
            guard let workspace = byName[workspaceName] else { return [] }
            return threads
                .filter { !$0.isArchived }
                .map { Row(workspace: workspace, thread: $0, needsYou: workspace.awaitingInput) }
        }
        return rows.sorted { left, right in
            if left.needsYou != right.needsYou { return left.needsYou }
            return left.thread.updatedAt > right.thread.updatedAt
        }
    }
}

struct ChatsTabRow: View {
    @Environment(\.palette) private var palette
    let row: ChatsTabView.Row

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 6) {
                if row.needsYou {
                    Image(systemName: "person.wave.2.fill")
                        .imageScale(.small)
                        .foregroundStyle(WorkspaceStatusKind.blocked.swiftUIColor)
                }
                Text(row.thread.title.isEmpty ? "Untitled chat" : row.thread.title)
                    .font(Typeface.bodyStrong)
                    .foregroundStyle(palette.textStrong)
                    .lineLimit(1)
                Spacer(minLength: 6)
                Text(RelativeTime.format(epochSecondsString: row.thread.updatedAt))
                    .font(Typeface.micro)
                    .foregroundStyle(palette.textMuted)
            }
            HStack(spacing: 6) {
                Text(row.workspace.name)
                    .font(Typeface.monoSmall)
                Text(row.thread.provider)
                    .font(Typeface.micro)
            }
            .foregroundStyle(palette.textMuted)
            .lineLimit(1)
        }
        .padding(.horizontal, Metrics.rowInset)
        .padding(.vertical, 10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .contentShape(Rectangle())
        .panel()
    }
}

/// Opening a chat from the cross-workspace list needs its own store, because a
/// ChatStore is scoped to one workspace.
struct WorkspaceChatEntry: View {
    @Environment(AppModel.self) private var model
    let workspace: WorkspaceSummary
    let threadID: Int64
    @State private var store: ChatStore?

    var body: some View {
        Group {
            if let store {
                ChatView(store: store)
            } else {
                ProgressView()
            }
        }
        .task {
            guard store == nil, let session = model.session else { return }
            let store = ChatStore(session: session, workspace: workspace.name)
            await store.refreshThreads()
            await store.select(threadID: threadID)
            self.store = store
        }
    }
}
