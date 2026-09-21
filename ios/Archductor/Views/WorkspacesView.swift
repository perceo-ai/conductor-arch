import ArchcarKit
import SwiftUI

struct WorkspacesView: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        NavigationStack {
            content
                .navigationTitle(model.activeDaemon?.label ?? "Archductor")
                .navigationBarTitleDisplayMode(.inline)
        }
    }

    @ViewBuilder
    private var content: some View {
        if model.activeDaemon == nil {
            ContentUnavailableView(
                "No daemon paired",
                systemImage: "antenna.radiowaves.left.and.right",
                description: Text("Pair with the Archductor desktop app from the More tab."))
        } else if let error = model.connectionError {
            ContentUnavailableView {
                Label("Not connected", systemImage: "wifi.exclamationmark")
            } description: {
                Text(error)
            } actions: {
                Button("Try again") {
                    guard let daemon = model.activeDaemon else { return }
                    Task { await model.activate(daemon) }
                }
            }
        } else if let store = model.workspaces {
            WorkspaceList(store: store)
        } else {
            ProgressView("Connecting…")
        }
    }
}

struct WorkspaceList: View {
    let store: WorkspacesStore

    var body: some View {
        List {
            if store.isStale {
                // Last-known rows stay visible; this banner is what stops them
                // from being read as current.
                Label("Showing last known state — not connected", systemImage: "wifi.slash")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
            ForEach(store.workspaces) { workspace in
                WorkspaceRow(workspace: workspace)
            }
        }
        .listStyle(.plain)
        .refreshable { await store.refresh() }
        .overlay {
            if store.workspaces.isEmpty && !store.isStale {
                ContentUnavailableView(
                    "No workspaces", systemImage: "tray",
                    description: Text("Create one from the desktop app."))
            }
        }
    }
}

struct WorkspaceRow: View {
    let workspace: WorkspaceSummary

    private var status: WorkspaceStatusKind { WorkspaceStatusKind.kind(for: workspace) }

    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            HStack(spacing: 8) {
                Circle()
                    .fill(status.swiftUIColor)
                    .frame(width: 8, height: 8)
                    .accessibilityLabel(status.label)
                Text(workspace.name)
                    .font(.headline)
                    .lineLimit(1)
                Spacer(minLength: 8)
                Text(RelativeTime.format(epochSecondsString: workspace.updatedAt))
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            HStack(spacing: 8) {
                Text(workspace.repositoryName)
                Text(workspace.branch)
                    .monospaced()
                    .lineLimit(1)
                    .truncationMode(.middle)
            }
            .font(.caption)
            .foregroundStyle(.secondary)
            chips
        }
        .padding(.vertical, 3)
        .accessibilityElement(children: .combine)
    }

    @ViewBuilder
    private var chips: some View {
        HStack(spacing: 6) {
            // awaiting_input is not part of the shared status scale, but it is
            // the one thing worth interrupting someone for, so it leads.
            if workspace.awaitingInput {
                Chip(text: "needs you", systemImage: "person.wave.2.fill", tint: .orange)
            }
            if let activity = WorkspaceActivity.activity(for: workspace) {
                Chip(text: "\(activity.count)", systemImage: "bolt.fill")
                    .accessibilityLabel(activity.title)
            }
            if workspace.blockedTasks > 0 {
                Chip(text: "\(workspace.blockedTasks) blocked", systemImage: "exclamationmark.triangle")
            }
            if workspace.changedFiles > 0 {
                Chip(text: "+\(workspace.diffAdditions) −\(workspace.diffDeletions)", systemImage: "plusminus")
            }
            if let number = workspace.pullRequestNumber {
                Chip(text: "#\(number)", systemImage: "arrow.triangle.pull")
            }
        }
        .font(.caption2)
    }
}

struct Chip: View {
    let text: String
    let systemImage: String
    var tint: Color?

    var body: some View {
        Label(text, systemImage: systemImage)
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .background((tint ?? Color.secondary).opacity(tint == nil ? 0.12 : 0.22), in: Capsule())
            .foregroundStyle(tint ?? .secondary)
    }
}
