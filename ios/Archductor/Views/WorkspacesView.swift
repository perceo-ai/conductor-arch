import ArchcarKit
import SwiftUI

struct WorkspacesView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.palette) private var palette
    @State private var creatingIn: RepositorySummary?
    @State private var addingRepository = false

    var body: some View {
        NavigationStack {
            content
                .archductorScreen()
                .navigationTitle(model.activeDaemon?.label ?? "Archductor")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    if model.workspaces != nil {
                        ToolbarItem(placement: .topBarTrailing) {
                            Button {
                                addingRepository = true
                            } label: {
                                Image(systemName: "folder.badge.plus")
                            }
                            .accessibilityLabel("Add repository")
                        }
                    }
                }
                .sheet(item: $creatingIn) { repository in
                    NewWorkspaceSheet(repository: repository)
                }
                .sheet(isPresented: $addingRepository) {
                    AddRepositorySheet()
                }
        }
    }

    @ViewBuilder
    private var content: some View {
        if model.activeDaemon == nil {
            EmptyStateView(
                title: "No daemon paired",
                systemImage: "antenna.radiowaves.left.and.right",
                detail: "Pair with the Archductor desktop app from the More tab.")
        } else if let error = model.connectionError {
            EmptyStateView(
                title: "Not connected",
                systemImage: "wifi.exclamationmark",
                detail: error,
                action: (
                    label: "Try again",
                    run: {
                        guard let daemon = model.activeDaemon else { return }
                        Task { await model.activate(daemon) }
                    }
                ))
        } else if let store = model.workspaces {
            WorkspaceList(store: store, creatingIn: $creatingIn)
        } else {
            VStack(spacing: 8) {
                ProgressView().tint(palette.textMuted)
                Text("Connecting…").font(Typeface.secondary).foregroundStyle(palette.textMuted)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(palette.bg)
        }
    }
}

/// Repository headings with workspace cards under them.
///
/// A `List` is not used here: its cell chrome — inset grouped fills, chevrons,
/// separators — is exactly the system look the desktop does not have, and
/// overriding each piece costs more than laying the rows out directly.
struct WorkspaceList: View {
    @Environment(\.palette) private var palette
    let store: WorkspacesStore
    @Binding var creatingIn: RepositorySummary?

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 18, pinnedViews: []) {
                if store.isStale {
                    HStack(spacing: 6) {
                        Image(systemName: "wifi.slash")
                        Text("Showing last known state — not connected")
                    }
                    .font(Typeface.secondary)
                    .foregroundStyle(palette.warning)
                    .padding(.horizontal, 10)
                    .padding(.vertical, 7)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .panel(fill: \.surface)
                }

                ForEach(store.groups) { group in
                    section(
                        title: group.repository.name,
                        trailing: "\(group.repository.activeWorkspaces) active",
                        workspaces: group.workspaces,
                        newWorkspaceIn: group.repository)
                }

                if !store.orphanedWorkspaces.isEmpty {
                    // Their repository is missing from the inventory; hiding
                    // them would make a workspace disappear with no explanation.
                    section(
                        title: "Repository missing", trailing: nil,
                        workspaces: store.orphanedWorkspaces, newWorkspaceIn: nil)
                }
            }
            .padding(.horizontal, Metrics.pageInset)
            .padding(.vertical, 14)
        }
        .archductorScreen()
        .refreshable { await store.refresh() }
        .overlay {
            if store.groups.isEmpty && store.orphanedWorkspaces.isEmpty && !store.isStale {
                EmptyStateView(
                    title: "No repositories", systemImage: "folder",
                    detail: "Add one with the button in the top right.")
            }
        }
    }

    @ViewBuilder
    private func section(
        title: String, trailing: String?, workspaces: [WorkspaceSummary],
        newWorkspaceIn repository: RepositorySummary?
    ) -> some View {
        VStack(alignment: .leading, spacing: 7) {
            SectionHeading(text: title, trailing: trailing)
            VStack(spacing: 6) {
                ForEach(workspaces) { workspace in
                    NavigationLink {
                        WorkspaceDetailView(workspace: workspace)
                    } label: {
                        WorkspaceRow(workspace: workspace)
                    }
                    .buttonStyle(.plain)
                    .contextMenu {
                        if workspace.status == "archived" {
                            Button("Restore") { Task { await store.restore(workspace) } }
                        } else {
                            Button("Archive", role: .destructive) {
                                Task { await store.archive(workspace, removeWorktree: false) }
                            }
                        }
                    }
                }
                if let repository {
                    Button {
                        creatingIn = repository
                    } label: {
                        HStack(spacing: 6) {
                            Image(systemName: "plus").imageScale(.small)
                            Text("New workspace")
                            Spacer()
                        }
                        .font(Typeface.secondary)
                        .foregroundStyle(palette.textMuted)
                        .padding(.horizontal, Metrics.rowInset)
                        .padding(.vertical, 9)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .panel(fill: \.surface)
                }
            }
        }
    }
}

struct WorkspaceRow: View {
    @Environment(\.palette) private var palette
    let workspace: WorkspaceSummary

    private var status: WorkspaceStatusKind { WorkspaceStatusKind.kind(for: workspace) }

    var body: some View {
        HStack(alignment: .top, spacing: 9) {
            // The dot sits on the row's first text baseline, not centred on the
            // card, so a two-line row still reads as one status per name.
            StatusDot(status: status)
                .padding(.top, 5)
            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 8) {
                    Text(workspace.name)
                        .font(Typeface.bodyStrong)
                        .foregroundStyle(palette.textStrong)
                        .lineLimit(1)
                    Spacer(minLength: 6)
                    Text(RelativeTime.format(epochSecondsString: workspace.updatedAt))
                        .font(Typeface.micro)
                        .foregroundStyle(palette.textMuted)
                }
                Text(workspace.branch)
                    .font(Typeface.monoSmall)
                    .foregroundStyle(palette.textMuted)
                    .lineLimit(1)
                    .truncationMode(.middle)
                chips
            }
        }
        .padding(.horizontal, Metrics.rowInset)
        .padding(.vertical, 10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .contentShape(Rectangle())
        .panel()
    }

    @ViewBuilder
    private var chips: some View {
        let items = chipItems
        if !items.isEmpty {
            HStack(spacing: 5) {
                ForEach(items, id: \.text) { item in
                    TintChip(text: item.text, systemImage: item.icon, kind: item.kind)
                }
            }
            .padding(.top, 1)
        }
    }

    private var chipItems: [(text: String, icon: String, kind: TintKind)] {
        var items: [(text: String, icon: String, kind: TintKind)] = []
        if workspace.awaitingInput {
            items.append(("needs you", "person.wave.2.fill", .warning))
        }
        if let activity = WorkspaceActivity.activity(for: workspace) {
            items.append(("\(activity.count)", "bolt.fill", .positive))
        }
        if workspace.blockedTasks > 0 {
            items.append(("\(workspace.blockedTasks) blocked", "exclamationmark.triangle", .negative))
        }
        if workspace.changedFiles > 0 {
            items.append(("+\(workspace.diffAdditions) −\(workspace.diffDeletions)", "plusminus", .info))
        }
        if let number = workspace.pullRequestNumber {
            items.append(("#\(number)", "arrow.triangle.pull", .info))
        }
        return items
    }
}
