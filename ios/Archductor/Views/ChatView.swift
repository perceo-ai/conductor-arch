import ArchcarKit
import SwiftUI

/// One conversation: the transcript, what is queued behind it, and whatever the
/// agent is currently blocked on.
struct ChatView: View {
    let store: ChatStore
    @State private var draft = ""
    @State private var showQueue = false
    @FocusState private var composerFocused: Bool

    var body: some View {
        VStack(spacing: 0) {
            transcript
            if store.isBlocked { blockedBanner }
            if !store.queued.isEmpty { queueStrip }
            composer
        }
        .navigationTitle(store.selectedThread?.title ?? "Chat")
        .navigationBarTitleDisplayMode(.inline)
        // A conversation is a full-screen surface: leaving the tab bar up
        // squeezes the composer against it and wastes the only vertical space
        // a phone has.
        .toolbar(.hidden, for: .tabBar)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Menu {
                    Toggle("Plan mode", isOn: Binding(
                        get: { store.planMode },
                        set: { enabled in Task { await store.setPlanMode(enabled) } }))
                    if let thread = store.selectedThread {
                        Section(thread.provider) {
                            if let model = thread.model { Text(model) }
                        }
                    }
                } label: {
                    Image(systemName: "ellipsis.circle")
                }
            }
        }
        .task { await store.observe() }
    }

    private var transcript: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 10) {
                    ForEach(store.items) { item in
                        TimelineRow(item: item).id(item.id)
                    }
                }
                .padding(.horizontal, 12)
                .padding(.vertical, 10)
            }
            .overlay {
                if store.items.isEmpty {
                    ContentUnavailableView(
                        "No messages yet", systemImage: "bubble.left",
                        description: Text("Send a turn to start this chat."))
                }
            }
            // Following the tail is the whole point of watching from a phone.
            .onChange(of: store.items.last?.id) { _, last in
                guard let last else { return }
                withAnimation(.easeOut(duration: 0.2)) { proxy.scrollTo(last, anchor: .bottom) }
            }
            .onChange(of: store.items.last?.body) { _, _ in
                guard let last = store.items.last?.id else { return }
                proxy.scrollTo(last, anchor: .bottom)
            }
        }
    }

    private var blockedBanner: some View {
        ForEach(store.pendingInteractions) { interaction in
            NavigationLink {
                InteractionView(store: store, interaction: interaction)
            } label: {
                HStack(spacing: 10) {
                    Image(systemName: "person.wave.2.fill")
                    VStack(alignment: .leading, spacing: 2) {
                        Text(interaction.title).font(.subheadline.weight(.semibold))
                        Text(interaction.kindLabel).font(.caption)
                    }
                    Spacer()
                    Image(systemName: "chevron.right").font(.caption)
                }
                .padding(12)
                .background(WorkspaceStatusKind.blocked.swiftUIColor.opacity(0.18))
            }
            .buttonStyle(.plain)
        }
    }

    private var queueStrip: some View {
        DisclosureGroup(isExpanded: $showQueue) {
            ForEach(store.queued) { input in
                HStack {
                    Text(input.displayText).font(.caption).lineLimit(2)
                    Spacer()
                    Button {
                        Task { await store.moveQueued(input, up: true) }
                    } label: {
                        Image(systemName: "arrow.up")
                    }
                    .buttonStyle(.borderless)
                    Button(role: .destructive) {
                        Task { await store.removeQueued(input) }
                    } label: {
                        Image(systemName: "trash")
                    }
                    .buttonStyle(.borderless)
                }
                .padding(.vertical, 2)
            }
        } label: {
            Label(
                "\(store.queued.count) queued turn\(store.queued.count == 1 ? "" : "s")",
                systemImage: "tray.full")
                .font(.caption)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 6)
        .background(.bar)
    }

    private var composer: some View {
        VStack(spacing: 6) {
            if let error = store.composerError {
                Text(error).font(.caption2).foregroundStyle(.red)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            HStack(alignment: .bottom, spacing: 8) {
                TextField("Message", text: $draft, axis: .vertical)
                    .lineLimit(1...5)
                    .textFieldStyle(.plain)
                    .focused($composerFocused)
                    .padding(8)
                    .background(Color.secondary.opacity(0.12), in: RoundedRectangle(cornerRadius: 16))
                    .accessibilityIdentifier("chat-composer")

                if store.isTurnRunning {
                    // A running turn gets a stop, not a second send: queueing
                    // behind your own unread reply is rarely what you meant.
                    Button {
                        Task { await store.interrupt() }
                    } label: {
                        Image(systemName: "stop.circle.fill").font(.title2)
                    }
                    .accessibilityIdentifier("chat-interrupt")
                } else {
                    Button {
                        let text = draft
                        draft = ""
                        Task { await store.send(text) }
                    } label: {
                        Image(systemName: "arrow.up.circle.fill").font(.title2)
                    }
                    .disabled(draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                        || store.isSending)
                    .accessibilityIdentifier("chat-send")
                }
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .background(.bar)
    }
}

struct TimelineRow: View {
    let item: ProjectionItem

    var body: some View {
        switch item.presentation {
        case .userMessage:
            bubble(alignment: .trailing, background: Color.accentColor.opacity(0.18))
        case .assistantMessage:
            bubble(alignment: .leading, background: Color.secondary.opacity(0.12))
        case .card:
            card
        }
    }

    private func bubble(alignment: HorizontalAlignment, background: Color) -> some View {
        HStack {
            if alignment == .trailing { Spacer(minLength: 40) }
            VStack(alignment: .leading, spacing: 4) {
                Text(item.displayBody)
                    .font(.callout)
                    .textSelection(.enabled)
            }
            .padding(10)
            .background(background, in: RoundedRectangle(cornerRadius: 14))
            if alignment == .leading { Spacer(minLength: 40) }
        }
    }

    private var card: some View {
        DisclosureGroup {
            Text(item.displayBody)
                .font(.caption.monospaced())
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
        } label: {
            HStack(spacing: 6) {
                Image(systemName: item.symbolName)
                // Verb plus what it acted on, the same split the desktop makes,
                // so "Ran cargo test" does not read as "Ran Ran cargo test".
                let label = ChatFormat.verbChip(renderClass: item.renderClass, title: item.title)
                Text(label.verb)
                    .font(.caption.weight(.semibold))
                if !label.chip.isEmpty {
                    Text(label.chip)
                        .font(.caption.monospaced())
                        .lineLimit(1)
                        .truncationMode(.middle)
                }
                if item.isStreaming { ProgressView().controlSize(.mini) }
            }
        }
        .padding(8)
        .background(Color.secondary.opacity(0.07), in: RoundedRectangle(cornerRadius: 10))
    }
}

extension ProviderInteraction {
    var kindLabel: String {
        switch kind {
        case .permission: "Wants permission"
        case .userQuestion: "Asked you a question"
        case .planApproval: "Wants plan approval"
        case .unknown: "Needs you"
        }
    }
}
