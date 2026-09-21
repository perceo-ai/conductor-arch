import ArchcarKit
import SwiftUI

struct WorkspacesView: View {
    @Environment(AppModel.self) private var model
    @State private var creatingIn: RepositorySummary?
    @State private var addingRepository = false

    var body: some View {
        NavigationStack {
            content
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
            WorkspaceList(store: store, creatingIn: $creatingIn)
        } else {
            ProgressView("Connecting…")
        }
    }
}

struct WorkspaceList: View {
    let store: WorkspacesStore
    @Binding var creatingIn: RepositorySummary?

    var body: some View {
        List {
            if store.isStale {
                Label("Showing last known state — not connected", systemImage: "wifi.slash")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
            ForEach(store.groups) { group in
                Section {
                    ForEach(group.workspaces) { workspace in
                        NavigationLink {
                            WorkspaceDetailView(workspace: workspace)
                        } label: {
                            WorkspaceRow(workspace: workspace)
                        }
                        .swipeActions(edge: .trailing) {
                            if workspace.status == "archived" {
                                Button("Restore") {
                                    Task { await store.restore(workspace) }
                                }
                            } else {
                                Button("Archive") {
                                    Task { await store.archive(workspace, removeWorktree: false) }
                                }
                                .tint(.orange)
                            }
                        }
                    }
                    Button {
                        creatingIn = group.repository
                    } label: {
                        Label("New workspace", systemImage: "plus")
                            .font(.subheadline)
                    }
                } header: {
                    HStack {
                        Text(group.repository.name)
                        Spacer()
                        Text("\(group.repository.activeWorkspaces) active")
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                    }
                }
            }
            if !store.orphanedWorkspaces.isEmpty {
                // Their repository is missing from the inventory; hiding them
                // would make a workspace disappear with no explanation.
                Section("Repository missing") {
                    ForEach(store.orphanedWorkspaces) { workspace in
                        NavigationLink {
                            WorkspaceDetailView(workspace: workspace)
                        } label: {
                            WorkspaceRow(workspace: workspace)
                        }
                    }
                }
            }
        }
        .listStyle(.insetGrouped)
        .refreshable { await store.refresh() }
        .overlay {
            if store.groups.isEmpty && store.orphanedWorkspaces.isEmpty && !store.isStale {
                ContentUnavailableView(
                    "No repositories", systemImage: "folder",
                    description: Text("Add one with the button in the top right."))
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
            Text(workspace.branch)
                .font(.caption)
                .monospaced()
                .lineLimit(1)
                .truncationMode(.middle)
                .foregroundStyle(.secondary)
            chips
        }
        .padding(.vertical, 3)
    }

    @ViewBuilder
    private var chips: some View {
        HStack(spacing: 6) {
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
