import ArchcarKit
import SwiftUI

/// One ranked list of what needs you, across every workspace.
///
/// The daemon ranks and orders it; this view only groups the given order into
/// the three shared tiers and never sorts.
struct AttentionView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.palette) private var palette
    @State private var queue: AttentionQueue?
    /// Set when the last fetch failed. A failed fetch is not an empty queue.
    @State private var loadError: String?
    @State private var path = NavigationPath()

    private struct Route: Hashable {
        let workspace: WorkspaceSummary
        let threadID: Int64?
    }

    var body: some View {
        NavigationStack(path: $path) {
            Group {
                if model.session == nil {
                    EmptyStateView(
                        title: "Not connected", systemImage: "wifi.slash",
                        detail: "Pair a daemon from the More tab.")
                } else {
                    content
                }
            }
            .archductorScreen()
            .navigationTitle("Attention")
            .navigationBarTitleDisplayMode(.inline)
            .navigationDestination(for: Route.self) { route in
                if let threadID = route.threadID {
                    WorkspaceChatEntry(workspace: route.workspace, threadID: threadID)
                } else {
                    WorkspaceDetailView(workspace: route.workspace)
                }
            }
        }
        // Keyed on the session itself: it is set only after the connection is
        // up, so a task keyed on the daemon id alone can run before it exists
        // and never run again. A new session also means a new daemon switch,
        // which resets everything below; a reconnect of the *same* session
        // (`handleForeground()` reconnects in place rather than replacing
        // it) is handled by `observeConnections()`, since nothing here would
        // otherwise notice a drop-and-reconnect.
        .task(id: model.session.map(ObjectIdentifier.init)) {
            queue = nil
            loadError = nil
            path = NavigationPath()
            await observeConnections()
        }
    }

    /// Reloads once per connection of this session — the very first one and
    /// every reconnect after it — never per daemon event, which is
    /// deliberately deferred (see the PR body). `connectedEvents()` only
    /// returns once the session is connected, so each pass through this loop
    /// represents exactly one connection; the events themselves are drained
    /// and discarded, which is what makes a reconnect the only thing that
    /// triggers another reload.
    ///
    /// The first load used to run separately, before this loop started, with
    /// the loop's own first iteration skipped on the assumption that the
    /// separate load had already answered for it. That assumption broke if
    /// the connection dropped *during* that first load: the load failed, but
    /// the skip still fired, so the reconnect which should have retried it
    /// was swallowed and the error sat on screen with nothing watching for
    /// it. Calling `load()` from inside this same loop for every connection,
    /// including the first, needs no such assumption and so cannot swallow
    /// that case: a drop mid-load simply means the loop's `connectedEvents()`
    /// waits, then this reloads once the reconnect completes.
    private func observeConnections() async {
        guard let session = model.session else { return }
        while !Task.isCancelled {
            guard let subscription = await session.connectedEvents() else { return }
            await load()
            for await _ in subscription.events {}
        }
    }

    @ViewBuilder
    private var content: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 6) {
                if let queue {
                    if let date = queue.generatedDate {
                        Text("As of \(Self.asOf(date))")
                            .font(Typeface.micro)
                            .foregroundStyle(palette.textMuted)
                    }
                    ForEach(Array(AttentionTier.sections(of: queue.items).enumerated()), id: \.offset) { _, section in
                        Text(section.tier.title)
                            .font(Typeface.micro)
                            .foregroundStyle(palette.textMuted)
                            .padding(.top, 8)
                        ForEach(Array(section.items.enumerated()), id: \.offset) { _, item in
                            row(item)
                        }
                    }
                }
                if let loadError {
                    Text(loadError)
                        .font(Typeface.secondary)
                        .foregroundStyle(WorkspaceStatusKind.blocked.swiftUIColor)
                }
            }
            .padding(.horizontal, Metrics.pageInset)
            .padding(.vertical, 14)
        }
        .refreshable { await load() }
        .overlay {
            if let queue, queue.items.isEmpty, loadError == nil {
                EmptyStateView(
                    title: "Nothing needs you", systemImage: "checkmark.circle",
                    detail: "Every workspace is quiet.")
            } else if queue == nil, loadError == nil {
                ProgressView()
            }
        }
    }

    private func workspace(for item: AttentionItem) -> WorkspaceSummary? {
        item.openableWorkspace(in: model.workspaces?.workspaces ?? [])
    }

    /// The time alone reads wrong once the queue is from another day.
    private static func asOf(_ date: Date) -> String {
        if Calendar.current.isDateInToday(date) {
            return date.formatted(date: .omitted, time: .shortened)
        }
        return date.formatted(date: .abbreviated, time: .shortened)
    }

    @ViewBuilder
    private func row(_ item: AttentionItem) -> some View {
        // A background task with no workspace carries the repository name in
        // `workspace`, which is not one. Such a row is shown but goes nowhere.
        let target = workspace(for: item)
        Button {
            guard let target else { return }
            path.append(Route(workspace: target, threadID: item.threadID))
        } label: {
            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 6) {
                    Image(systemName: Self.icon(item.kind))
                        .imageScale(.small)
                        .foregroundStyle(
                            AttentionTier.of(rank: item.rank) == .needsYouNow
                                ? WorkspaceStatusKind.blocked.swiftUIColor : palette.textMuted)
                    Text(item.workspace)
                        .font(Typeface.monoSmall)
                        .foregroundStyle(palette.textMuted)
                        .lineLimit(1)
                }
                Text(item.headline)
                    .font(Typeface.bodyStrong)
                    .foregroundStyle(palette.textStrong)
                    .multilineTextAlignment(.leading)
                if let detail = item.detail {
                    Text(detail)
                        .font(Typeface.secondary)
                        .foregroundStyle(palette.textMuted)
                        .multilineTextAlignment(.leading)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(Metrics.rowInset)
        }
        .buttonStyle(.plain)
        .disabled(target == nil)
    }

    private static func icon(_ kind: AttentionKind) -> String {
        switch kind {
        case .agentAsked: "questionmark.circle"
        case .sessionFailed, .checksFailed: "xmark.circle"
        case .stalled: "exclamationmark.circle"
        case .taskFinished: "checkmark.circle"
        case .prOpen: "arrow.triangle.pull"
        case .diffReady: "plusminus.circle"
        case .idle: "circle.dotted"
        case .unknown: "circle"
        }
    }

    private func load() async {
        guard let session = model.session else { return }
        do {
            let response = try await session.request(ListAttentionRequest())
            // A result for a session that is no longer current (daemon switch
            // while in flight) must not land on the new daemon's screen.
            guard !Task.isCancelled, model.session === session else { return }
            guard case .attention(let fetched) = response else {
                loadError = UserFacingMessage.unexpectedResponse
                return
            }
            queue = fetched
            loadError = nil
        } catch {
            guard !Task.isCancelled, model.session === session else { return }
            loadError = UserFacingMessage.describing(error)
        }
    }
}
