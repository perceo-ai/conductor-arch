import ArchcarKit
import SwiftUI

/// One workspace, drilled into from the list.
///
/// The segmented control carries the desktop's panel names so the two surfaces
/// describe a workspace the same way; P1 fills in Chat, and the rest arrive in
/// their own phases rather than being faked now.
struct WorkspaceDetailView: View {
    @Environment(AppModel.self) private var model
    let workspace: WorkspaceSummary

    @State private var panel: Panel = .chat
    @State private var store: ChatStore?
    @State private var creating = false

    enum Panel: String, CaseIterable, Identifiable {
        case chat = "Chat"
        case changes = "Changes"
        case checks = "Checks"
        case files = "Files"
        var id: String { rawValue }
    }

    var body: some View {
        VStack(spacing: 0) {
            Picker("Panel", selection: $panel) {
                ForEach(Panel.allCases) { panel in Text(panel.rawValue).tag(panel) }
            }
            .pickerStyle(.segmented)
            .padding(.horizontal, 12)
            .padding(.vertical, 8)

            switch panel {
            case .chat:
                chatPanel
            case .changes, .checks, .files:
                ContentUnavailableView(
                    panel.rawValue, systemImage: "hourglass",
                    description: Text("Review surfaces land in the next phase."))
            }
        }
        .navigationTitle(workspace.name)
        .navigationBarTitleDisplayMode(.inline)
        .task {
            guard store == nil, let session = model.session else { return }
            let store = ChatStore(session: session, workspace: workspace.name)
            self.store = store
            await store.refreshThreads()
        }
    }

    @ViewBuilder
    private var chatPanel: some View {
        if let store {
            List {
                Section {
                    ForEach(store.threads) { thread in
                        NavigationLink {
                            ChatThreadScreen(store: store, thread: thread)
                        } label: {
                            ChatThreadRow(thread: thread)
                        }
                    }
                }
                Section {
                    Button {
                        creating = true
                    } label: {
                        Label("New chat", systemImage: "plus.bubble")
                    }
                }
            }
            .listStyle(.plain)
            .overlay {
                if store.threads.isEmpty {
                    ContentUnavailableView(
                        "No chats", systemImage: "bubble.left.and.bubble.right",
                        description: Text("Start one to put an agent on this workspace."))
                }
            }
            .refreshable { await store.refreshThreads() }
            .sheet(isPresented: $creating) {
                NewChatSheet(store: store)
            }
        } else {
            ProgressView()
        }
    }
}

/// Selecting a thread loads it, so the transcript screen is never shown against
/// a stale selection.
struct ChatThreadScreen: View {
    let store: ChatStore
    let thread: ChatThread

    var body: some View {
        ChatView(store: store)
            .task { await store.select(threadID: thread.id) }
    }
}

struct ChatThreadRow: View {
    let thread: ChatThread

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(thread.title.isEmpty ? "Untitled chat" : thread.title)
                .font(.subheadline)
                .lineLimit(1)
            HStack(spacing: 6) {
                Text(thread.provider)
                if let model = thread.model { Text(model) }
                Spacer()
                Text(RelativeTime.format(epochSecondsString: thread.updatedAt))
            }
            .font(.caption2)
            .foregroundStyle(.secondary)
        }
    }
}

struct NewChatSheet: View {
    let store: ChatStore
    @Environment(\.dismiss) private var dismiss
    @State private var provider = "codex"
    @State private var title = ""
    @State private var working = false

    /// The providers the daemon can drive as managed chat sessions. A shell has
    /// no turn model, so it is not offered here.
    private let providers = ["codex", "claude"]

    var body: some View {
        NavigationStack {
            Form {
                Picker("Agent", selection: $provider) {
                    ForEach(providers, id: \.self) { Text($0).tag($0) }
                }
                TextField("Title", text: $title)
            }
            .navigationTitle("New chat")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Create") {
                        working = true
                        Task {
                            let name = title.trimmingCharacters(in: .whitespacesAndNewlines)
                            _ = await store.createThread(
                                provider: provider,
                                title: name.isEmpty ? "From phone" : name)
                            working = false
                            dismiss()
                        }
                    }
                    .disabled(working)
                }
            }
        }
    }
}
