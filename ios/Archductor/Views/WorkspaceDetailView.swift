import ArchcarKit
import SwiftUI

/// One workspace, drilled into from the list.
///
/// The segmented control carries the desktop's panel names so the two surfaces
/// describe a workspace the same way; P1 fills in Chat, and the rest arrive in
/// their own phases rather than being faked now.
struct WorkspaceDetailView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.palette) private var palette
    let workspace: WorkspaceSummary

    @State private var panel: Panel = .chat
    @State private var store: ChatStore?
    @State private var review: ReviewStore?
    @State private var files: FilesStore?
    @State private var terminal: TerminalStore?
    @State private var creating = false

    enum Panel: String, CaseIterable, Identifiable {
        case chat = "Chat"
        case changes = "Changes"
        case checks = "Checks"
        case todos = "Todos"
        case files = "Files"
        case terminal = "Terminal"
        var id: String { rawValue }
    }

    var body: some View {
        VStack(spacing: 0) {
            // Six panels do not fit a phone's width as a segmented control.
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 5) {
                    ForEach(Panel.allCases) { item in
                        let selected = panel == item
                        Button {
                            panel = item
                        } label: {
                            Text(item.rawValue)
                                .font(.system(size: 12, weight: selected ? .semibold : .regular))
                                .foregroundStyle(selected ? palette.accent : palette.textMuted)
                                .padding(.horizontal, 11)
                                .padding(.vertical, 6)
                                .background(
                                    selected ? palette.accentWash : palette.surface,
                                    in: Capsule())
                                .overlay(
                                    Capsule().strokeBorder(
                                        selected ? palette.accentEdge : palette.border,
                                        lineWidth: Metrics.hairline))
                        }
                        .buttonStyle(.plain)
                    }
                }
                .padding(.horizontal, Metrics.pageInset)
                .padding(.vertical, 9)
            }
            .background(palette.bg)
            .overlay(alignment: .bottom) {
                Rectangle().fill(palette.border).frame(height: Metrics.hairline)
            }

            switch panel {
            case .chat:
                chatPanel
            case .changes:
                if let review { ChangesPanel(store: review) } else { ProgressView() }
            case .checks:
                if let review { ChecksPanel(store: review) } else { ProgressView() }
            case .todos:
                if let review { TodosPanel(store: review) } else { ProgressView() }
            case .files:
                if let files { FilesPanel(store: files) } else { ProgressView() }
            case .terminal:
                if let terminal { TerminalPanel(store: terminal) } else { ProgressView() }
            }
        }
        .background(palette.bg)
        .navigationTitle(workspace.name)
        .navigationBarTitleDisplayMode(.inline)
        .task {
            guard store == nil, let session = model.session else { return }
            let store = ChatStore(session: session, workspace: workspace.name)
            self.store = store
            let review = ReviewStore(session: session, workspace: workspace.name)
            self.review = review
            files = FilesStore(session: session, workspace: workspace.name)
            // The shell is only spawned when the Terminal panel is opened; a
            // workspace should not gain a process because someone looked at it.
            terminal = TerminalStore(session: session, workspace: workspace.name)
            await store.refreshThreads()
            await review.refreshAll()
        }
        .task {
            // Keeps the review panels live while the workspace is open, so a
            // turn that writes files updates the changes list without a pull.
            guard let review else { return }
            await review.observe()
        }
    }

    @ViewBuilder
    private var chatPanel: some View {
        if let store {
            ScrollView {
                LazyVStack(spacing: 6) {
                    ForEach(store.threads) { thread in
                        NavigationLink {
                            ChatThreadScreen(store: store, thread: thread)
                        } label: {
                            ChatThreadRow(thread: thread)
                        }
                        .buttonStyle(.plain)
                    }
                    Button {
                        creating = true
                    } label: {
                        HStack(spacing: 6) {
                            Image(systemName: "plus.bubble").imageScale(.small)
                            Text("New chat")
                            Spacer()
                        }
                        .font(Typeface.secondary)
                        .foregroundStyle(palette.textMuted)
                        .padding(.horizontal, Metrics.rowInset)
                        .padding(.vertical, 10)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .panel(fill: \.surface)
                }
                .padding(.horizontal, Metrics.pageInset)
                .padding(.vertical, 12)
            }
            .archductorScreen()
            .overlay {
                if store.threads.isEmpty {
                    EmptyStateView(
                        title: "No chats", systemImage: "bubble.left.and.bubble.right",
                        detail: "Start one to put an agent on this workspace.")
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
    @Environment(\.palette) private var palette
    let thread: ChatThread

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(thread.title.isEmpty ? "Untitled chat" : thread.title)
                .font(Typeface.bodyStrong)
                .foregroundStyle(palette.textStrong)
                .lineLimit(1)
            HStack(spacing: 5) {
                TintChip(text: thread.provider, kind: .info)
                if let model = thread.model {
                    Text(model).font(Typeface.monoSmall).foregroundStyle(palette.textMuted)
                }
                Spacer(minLength: 6)
                Text(RelativeTime.format(epochSecondsString: thread.updatedAt))
                    .font(Typeface.micro)
                    .foregroundStyle(palette.textMuted)
            }
        }
        .padding(.horizontal, Metrics.rowInset)
        .padding(.vertical, 10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .contentShape(Rectangle())
        .panel()
    }
}

struct NewChatSheet: View {
    let store: ChatStore
    @Environment(\.dismiss) private var dismiss
    @Environment(AppModel.self) private var model
    @State private var provider = "codex"
    @State private var title = ""
    @State private var working = false
    @State private var providers: [AgentProvider] = []

    var body: some View {
        NavigationStack {
            Form {
                Picker("Agent", selection: $provider) {
                    // The registry comes from the daemon, so an agent added
                    // there shows up here without an app update.
                    ForEach(providers) { agent in
                        Text(agent.displayName).tag(agent.providerKey)
                    }
                }
                TextField("Title", text: $title)
                if let guidance = providers.first(where: { $0.providerKey == provider })?.authGuidance,
                   !guidance.isEmpty {
                    Text(guidance).font(.caption).foregroundStyle(.secondary)
                }
            }
            .task {
                guard providers.isEmpty, let session = model.session else { return }
                providers = await AgentProviderCatalog.launchable(session: session)
                if let first = providers.first, !providers.contains(where: { $0.providerKey == provider }) {
                    provider = first.providerKey
                }
            }
            .archductorForm()
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
