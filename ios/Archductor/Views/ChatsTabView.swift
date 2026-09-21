import ArchcarKit
import SwiftUI

/// Every chat on this daemon, sorted by what needs a human first.
///
/// The ordering is the point of the tab: "who is waiting on me" should be one
/// glance from launch, not a walk through workspaces.
struct ChatsTabView: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        NavigationStack {
            Group {
                if let store = model.workspaces {
                    list(store)
                } else {
                    ContentUnavailableView(
                        "Not connected", systemImage: "wifi.slash",
                        description: Text("Pair a daemon from the More tab."))
                }
            }
            .navigationTitle("Chats")
        }
    }

    private func list(_ store: WorkspacesStore) -> some View {
        List {
            ForEach(rows(store), id: \.id) { row in
                NavigationLink {
                    WorkspaceChatEntry(workspace: row.workspace, threadID: row.thread.id)
                } label: {
                    ChatsTabRow(row: row)
                }
            }
        }
        .listStyle(.plain)
        .refreshable { await store.refresh() }
        .overlay {
            if rows(store).isEmpty {
                ContentUnavailableView(
                    "No chats yet", systemImage: "bubble.left.and.bubble.right",
                    description: Text("Open a workspace to start one."))
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
    let row: ChatsTabView.Row

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack(spacing: 6) {
                if row.needsYou {
                    Image(systemName: "person.wave.2.fill")
                        .foregroundStyle(WorkspaceStatusKind.blocked.swiftUIColor)
                }
                Text(row.thread.title.isEmpty ? "Untitled chat" : row.thread.title)
                    .font(.subheadline)
                    .lineLimit(1)
                Spacer()
                Text(RelativeTime.format(epochSecondsString: row.thread.updatedAt))
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }
            HStack(spacing: 6) {
                Text(row.workspace.name)
                Text(row.thread.provider)
            }
            .font(.caption2)
            .foregroundStyle(.secondary)
        }
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
