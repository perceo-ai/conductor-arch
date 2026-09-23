import ArchcarKit
import SwiftUI

/// One conversation: the transcript, what is queued behind it, and whatever the
/// agent is currently blocked on.
struct ChatView: View {
    @Environment(\.palette) private var palette
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
        .background(palette.bg)
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
                        // Model and effort switch on the live session, so they
                        // need one to exist; before that the menu says so
                        // rather than offering a control that cannot work.
                        let models = AgentModels.models(for: thread.provider)
                        if !models.isEmpty {
                            Menu("Model") {
                                ForEach(models, id: \.self) { model in
                                    Button {
                                        Task { await store.setModel(model) }
                                    } label: {
                                        if model == thread.model {
                                            Label(AgentModels.label(model), systemImage: "checkmark")
                                        } else {
                                            Text(AgentModels.label(model))
                                        }
                                    }
                                }
                            }
                            .disabled(!store.hasLiveSession)

                            Menu("Effort") {
                                ForEach(AgentModels.efforts, id: \.self) { effort in
                                    Button {
                                        Task { await store.setEffort(effort) }
                                    } label: {
                                        if effort == thread.effortMode {
                                            Label(effort.capitalized, systemImage: "checkmark")
                                        } else {
                                            Text(effort.capitalized)
                                        }
                                    }
                                }
                            }
                            .disabled(!store.hasLiveSession)
                        }

                        Section {
                            Text(thread.model.map(AgentModels.label) ?? thread.provider)
                            if !store.hasLiveSession {
                                Text("Send a turn to start the session")
                            }
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
            .archductorScreen()
            .overlay {
                if store.items.isEmpty {
                    EmptyStateView(
                        title: "No messages yet", systemImage: "bubble.left",
                        detail: "Send a turn to start this chat.")
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
                        .foregroundStyle(WorkspaceStatusKind.blocked.swiftUIColor)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(interaction.title)
                            .font(Typeface.bodyStrong)
                            .foregroundStyle(palette.textStrong)
                        Text(interaction.kindLabel)
                            .font(Typeface.secondary)
                            .foregroundStyle(palette.textMuted)
                    }
                    Spacer()
                    Image(systemName: "chevron.right")
                        .font(.system(size: 11, weight: .semibold))
                        .foregroundStyle(palette.textMuted)
                }
                .padding(Metrics.rowInset)
                .background(WorkspaceStatusKind.blocked.swiftUIColor.opacity(0.14))
                .overlay(alignment: .top) {
                    Rectangle().fill(palette.border).frame(height: Metrics.hairline)
                }
            }
            .buttonStyle(.plain)
        }
    }

    private var queueStrip: some View {
        DisclosureGroup(isExpanded: $showQueue) {
            ForEach(store.queued) { input in
                HStack {
                    Text(input.displayText)
                        .font(Typeface.secondary)
                        .foregroundStyle(palette.text)
                        .lineLimit(2)
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
                .font(Typeface.secondary)
                .foregroundStyle(palette.textMuted)
        }
        .tint(palette.accent)
        .padding(.horizontal, Metrics.pageInset)
        .padding(.vertical, 7)
        .background(palette.surface)
        .overlay(alignment: .top) {
            Rectangle().fill(palette.border).frame(height: Metrics.hairline)
        }
    }

    private var composer: some View {
        VStack(spacing: 6) {
            if let error = store.composerError {
                Text(error)
                    .font(Typeface.micro)
                    .foregroundStyle(palette.danger)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            HStack(alignment: .bottom, spacing: 8) {
                TextField("Message", text: $draft, axis: .vertical)
                    .lineLimit(1...5)
                    .textFieldStyle(.plain)
                    .font(Typeface.body)
                    .foregroundStyle(palette.text)
                    .focused($composerFocused)
                    .padding(.horizontal, 10)
                    .padding(.vertical, 8)
                    .panel(fill: \.surfaceRaised, radius: Metrics.radiusMedium)
                    .accessibilityIdentifier("chat-composer")

                if store.isTurnRunning {
                    // A running turn gets a stop, not a second send: queueing
                    // behind your own unread reply is rarely what you meant.
                    Button {
                        Task { await store.interrupt() }
                    } label: {
                        Image(systemName: "stop.circle.fill")
                            .font(.system(size: 26))
                            .foregroundStyle(palette.danger)
                    }
                    .accessibilityIdentifier("chat-interrupt")
                } else {
                    Button {
                        let text = draft
                        draft = ""
                        Task { await store.send(text) }
                    } label: {
                        Image(systemName: "arrow.up.circle.fill")
                            .font(.system(size: 26))
                            .foregroundStyle(
                                draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                                    ? palette.textMuted : palette.accent)
                    }
                    .disabled(draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                        || store.isSending)
                    .accessibilityIdentifier("chat-send")
                }
            }
        }
        .padding(.horizontal, Metrics.pageInset)
        .padding(.vertical, 8)
        .background(palette.surface)
        .overlay(alignment: .top) {
            Rectangle().fill(palette.border).frame(height: Metrics.hairline)
        }
    }
}

struct TimelineRow: View {
    @Environment(\.palette) private var palette
    let item: ProjectionItem

    var body: some View {
        switch item.presentation {
        case .userMessage:
            // The desktop tints the user's own turns with the accent wash and
            // leaves the agent on a plain panel, so the eye can find "what did
            // I ask" while scrolling.
            bubble(alignment: .trailing, background: palette.accentWash, edge: palette.accentEdge)
        case .assistantMessage:
            bubble(alignment: .leading, background: palette.surfaceRaised, edge: palette.border)
        case .card:
            card
        }
    }

    private func bubble(alignment: HorizontalAlignment, background: Color, edge: Color) -> some View {
        HStack {
            if alignment == .trailing { Spacer(minLength: 36) }
            VStack(alignment: .leading, spacing: 4) {
                Text(item.displayBody)
                    .font(Typeface.body)
                    .foregroundStyle(palette.text)
                    .textSelection(.enabled)
            }
            .padding(.horizontal, 11)
            .padding(.vertical, 9)
            .background(background, in: RoundedRectangle(cornerRadius: Metrics.radiusMedium, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: Metrics.radiusMedium, style: .continuous)
                    .strokeBorder(edge, lineWidth: Metrics.hairline))
            if alignment == .leading { Spacer(minLength: 36) }
        }
    }

    private var card: some View {
        DisclosureGroup {
            Text(item.displayBody)
                .font(Typeface.code)
                .foregroundStyle(palette.codeText)
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.top, 6)
        } label: {
            HStack(spacing: 6) {
                Image(systemName: item.symbolName)
                    .imageScale(.small)
                    .foregroundStyle(palette.textMuted)
                // Verb plus what it acted on, the same split the desktop makes,
                // so "Ran cargo test" does not read as "Ran Ran cargo test".
                let label = ChatFormat.verbChip(renderClass: item.renderClass, title: item.title)
                Text(label.verb)
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(palette.text)
                if !label.chip.isEmpty {
                    Text(label.chip)
                        .font(Typeface.monoSmall)
                        .foregroundStyle(palette.textMuted)
                        .lineLimit(1)
                        .truncationMode(.middle)
                }
                if item.isStreaming {
                    ProgressView().controlSize(.mini).tint(palette.accent)
                }
            }
        }
        .tint(palette.textMuted)
        .padding(.horizontal, 10)
        .padding(.vertical, 8)
        .panel(fill: \.surface)
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
