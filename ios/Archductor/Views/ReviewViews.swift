import ArchcarKit
import SwiftUI

/// Changed files, with a scope picker matching the desktop's.
struct ChangesPanel: View {
    let store: ReviewStore
    @State private var committing = false

    var body: some View {
        List {
            Section {
                Picker("Scope", selection: Binding(
                    get: { store.scope },
                    set: { scope in Task { await store.setScope(scope) } })) {
                    Text("All").tag(WorkspaceChangeScope.all)
                    Text("Uncommitted").tag(WorkspaceChangeScope.uncommitted)
                }
                .pickerStyle(.segmented)
            }

            ForEach(store.files) { file in
                NavigationLink {
                    DiffView(store: store, path: file.path)
                } label: {
                    ChangedFileRow(file: file)
                }
            }

            if !store.files.isEmpty {
                Section {
                    Button {
                        committing = true
                    } label: {
                        Label("Commit these changes", systemImage: "checkmark.seal")
                    }
                }
            }
        }
        .listStyle(.plain)
        .refreshable { await store.refreshChanges() }
        .overlay {
            if store.files.isEmpty {
                ContentUnavailableView(
                    "No changes", systemImage: "checkmark.circle",
                    description: Text("Nothing differs from \(store.scope.label.lowercased())."))
            }
        }
        .sheet(isPresented: $committing) { CommitSheet(store: store) }
    }
}

struct ChangedFileRow: View {
    let file: DiffFileSummary

    var body: some View {
        HStack(spacing: 10) {
            Text(file.stateLabel)
                .font(.caption2.monospaced().weight(.semibold))
                .frame(width: 22)
                .foregroundStyle(file.untracked ? .green : .orange)
            VStack(alignment: .leading, spacing: 2) {
                Text(file.fileName).font(.subheadline).lineLimit(1)
                if !file.directory.isEmpty {
                    Text(file.directory)
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                        .truncationMode(.head)
                }
            }
            Spacer()
            if let additions = file.additions, let deletions = file.deletions {
                Text("+\(additions) −\(deletions)")
                    .font(.caption2.monospaced())
                    .foregroundStyle(.secondary)
            }
        }
    }
}

/// A unified diff, coloured. Monospaced and horizontally scrollable, because
/// wrapping code on a phone makes it unreadable.
struct DiffView: View {
    let store: ReviewStore
    let path: String

    @State private var lines: [DiffLine] = []
    @State private var truncated = false
    @State private var loading = true

    var body: some View {
        Group {
            if loading {
                ProgressView()
            } else if lines.isEmpty {
                ContentUnavailableView("No diff", systemImage: "doc")
            } else {
                // A two-axis ScrollView centres content smaller than the
                // viewport, which pushes a short diff into the middle of the
                // screen under a dead gap. Code reads from the top left.
                ScrollView([.vertical, .horizontal]) {
                    LazyVStack(alignment: .leading, spacing: 0) {
                        ForEach(lines) { line in
                            Text(line.text.isEmpty ? " " : line.text)
                                .font(.system(.caption, design: .monospaced))
                                .foregroundStyle(colour(for: line.kind))
                                .padding(.horizontal, 8)
                                .padding(.vertical, 1)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .background(background(for: line.kind))
                        }
                        if truncated {
                            Text("… diff truncated at \(DiffParser.lineLimit) lines")
                                .font(.caption2)
                                .foregroundStyle(.secondary)
                                .padding(8)
                        }
                    }
                }
                .defaultScrollAnchor(.topLeading)
            }
        }
        .navigationTitle(path.split(separator: "/").last.map(String.init) ?? path)
        .navigationBarTitleDisplayMode(.inline)
        .task {
            let text = await store.diff(for: path) ?? ""
            let parsed = DiffParser.parse(text)
            lines = parsed.lines
            truncated = parsed.truncated
            loading = false
        }
    }

    private func colour(for kind: DiffLine.Kind) -> Color {
        switch kind {
        case .addition: .green
        case .deletion: .red
        case .hunkHeader: .accentColor
        case .fileHeader: .secondary
        case .context: .primary
        }
    }

    private func background(for kind: DiffLine.Kind) -> Color {
        switch kind {
        case .addition: Color.green.opacity(0.10)
        case .deletion: Color.red.opacity(0.10)
        default: .clear
        }
    }
}

/// Checks, CI runs, and the pull request.
struct ChecksPanel: View {
    let store: ReviewStore
    @State private var creatingPR = false

    var body: some View {
        List {
            if let checks = store.checks {
                Section("Workspace") {
                    LabeledContent("Changed files", value: "\(checks.changedFiles)")
                    if let status = checks.checkStatus {
                        LabeledContent("Checks") {
                            Text(status)
                                .foregroundStyle(status == "passed" ? .green : .orange)
                        }
                    }
                    if let ahead = checks.branchAhead {
                        LabeledContent("Ahead", value: "\(ahead)")
                    }
                    if let behind = checks.branchBehind, behind > 0 {
                        LabeledContent("Behind", value: "\(behind)")
                    }
                    LabeledContent("Open todos", value: "\(checks.openTodos)")
                }
            }

            Section("CI") {
                if let runs = store.runs {
                    if let unavailable = runs.unavailable {
                        // The reason is always on the daemon's machine — no gh,
                        // no auth, no remote — so show it rather than an empty list.
                        Label(unavailable, systemImage: "exclamationmark.triangle")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    } else if runs.runs.isEmpty {
                        Text("No runs for this branch").font(.footnote).foregroundStyle(.secondary)
                    } else {
                        ForEach(runs.runs) { run in
                            WorkflowRunRow(run: run)
                        }
                    }
                } else {
                    ProgressView()
                }
            }

            Section("Pull request") {
                if let number = store.checks?.pullRequestNumber {
                    LabeledContent("Number", value: "#\(number)")
                    Button {
                        Task { await store.mergePullRequest(method: "squash") }
                    } label: {
                        Label("Squash and merge", systemImage: "arrow.triangle.merge")
                    }
                    .disabled(store.isBusy)
                } else {
                    Button {
                        creatingPR = true
                    } label: {
                        Label("Create pull request", systemImage: "arrow.triangle.pull")
                    }
                    .disabled(store.isBusy)
                }
                Button {
                    Task { await store.push() }
                } label: {
                    Label("Push branch", systemImage: "arrow.up.circle")
                }
                .disabled(store.isBusy)
            }

            if let output = store.actionOutput {
                Section("Last action") {
                    Text(output).font(.caption.monospaced()).textSelection(.enabled)
                }
            }
            if let error = store.lastError {
                Section { Text(error).font(.caption).foregroundStyle(.red) }
            }
        }
        .refreshable { await store.refreshChecks() }
        .sheet(isPresented: $creatingPR) { CreatePullRequestSheet(store: store) }
    }
}

struct WorkflowRunRow: View {
    let run: WorkflowRun

    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: icon)
                .foregroundStyle(tint)
            VStack(alignment: .leading, spacing: 2) {
                Text(run.name).font(.subheadline).lineLimit(1)
                Text(run.isRunning ? run.status : run.conclusion)
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }
            Spacer()
            Link(destination: URL(string: run.url) ?? URL(string: "https://github.com")!) {
                Image(systemName: "arrow.up.forward.square")
            }
        }
    }

    private var icon: String {
        if run.isRunning { return "clock" }
        return run.isFailure ? "xmark.circle.fill" : "checkmark.circle.fill"
    }

    private var tint: Color {
        if run.isRunning { return .secondary }
        return run.isFailure ? .red : .green
    }
}

struct TodosPanel: View {
    let store: ReviewStore
    @State private var draft = ""

    var body: some View {
        List {
            ForEach(store.todos) { todo in
                HStack(alignment: .top, spacing: 8) {
                    Image(systemName: todo.isOpen ? "circle" : "checkmark.circle.fill")
                        .foregroundStyle(todo.isOpen ? Color.secondary : Color.green)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(todo.text).font(.subheadline)
                        Text(todo.source).font(.caption2).foregroundStyle(.secondary)
                    }
                }
            }
            Section {
                HStack {
                    TextField("Add a todo", text: $draft)
                    Button("Add") {
                        let text = draft
                        draft = ""
                        Task { await store.addTodo(text) }
                    }
                    .disabled(draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
            }
        }
        .refreshable { await store.refreshTodos() }
        .overlay {
            if store.todos.isEmpty {
                ContentUnavailableView("No todos", systemImage: "checklist")
            }
        }
    }
}

struct CommitSheet: View {
    let store: ReviewStore
    @Environment(\.dismiss) private var dismiss
    @State private var message = ""
    @State private var working = false

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("Message", text: $message, axis: .vertical).lineLimit(2...6)
                } footer: {
                    Text("Stages everything in the worktree, the same as the desktop's commit.")
                }
            }
            .navigationTitle("Commit")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Commit") {
                        working = true
                        Task {
                            await store.commit(message: message)
                            working = false
                            dismiss()
                        }
                    }
                    .disabled(working || message.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
            }
        }
    }
}

struct CreatePullRequestSheet: View {
    let store: ReviewStore
    @Environment(\.dismiss) private var dismiss
    @State private var title = ""
    @State private var body_ = ""
    @State private var draft = false
    @State private var loading = true
    @State private var working = false

    var body: some View {
        NavigationStack {
            Form {
                if loading {
                    HStack { ProgressView(); Text("Drafting from the workspace…") }
                } else {
                    Section("Title") { TextField("Title", text: $title) }
                    Section("Body") {
                        TextField("Body", text: $body_, axis: .vertical).lineLimit(4...12)
                    }
                    Toggle("Draft pull request", isOn: $draft)
                }
            }
            .navigationTitle("New pull request")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Create") {
                        working = true
                        Task {
                            await store.createPullRequest(
                                title: title.isEmpty ? nil : title,
                                body: body_.isEmpty ? nil : body_,
                                draft: draft)
                            working = false
                            dismiss()
                        }
                    }
                    .disabled(working || loading)
                }
            }
            // The daemon drafts title and body from the workspace's summary,
            // tasks, and agent contributions. Typing that on a phone is the
            // thing nobody would do.
            .task {
                if let draftContent = await store.pullRequestDraft() {
                    title = draftContent.title
                    body_ = draftContent.body
                }
                loading = false
            }
        }
    }
}
