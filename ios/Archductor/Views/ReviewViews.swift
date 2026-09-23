import ArchcarKit
import SwiftUI

/// Changed files, with a scope picker matching the desktop's.
struct ChangesPanel: View {
    @Environment(\.palette) private var palette
    let store: ReviewStore
    @State private var committing = false

    var body: some View {
        VStack(spacing: 0) {
            SegmentedScope(
                scope: store.scope,
                select: { scope in Task { await store.setScope(scope) } })
                .padding(.horizontal, Metrics.pageInset)
                .padding(.vertical, 9)
                .background(palette.bg)

            ScrollView {
                LazyVStack(spacing: 6) {
                    ForEach(store.files) { file in
                        NavigationLink {
                            DiffView(store: store, path: file.path)
                        } label: {
                            ChangedFileRow(file: file)
                        }
                        .buttonStyle(.plain)
                    }
                    if !store.files.isEmpty {
                        Button("Commit these changes") { committing = true }
                            .buttonStyle(AccentButtonStyle())
                            .padding(.top, 6)
                    }
                }
                .padding(.horizontal, Metrics.pageInset)
                .padding(.bottom, 14)
            }
            .archductorScreen()
            .refreshable { await store.refreshChanges() }
            .overlay {
                if let failure = store.changesError {
                    // Never claim a clean tree on a failed fetch — that is a
                    // statement about someone's work, and it would be wrong.
                    EmptyStateView(
                        title: "Could not list changes",
                        systemImage: "exclamationmark.triangle",
                        detail: failure,
                        action: (label: "Try again", run: {
                            Task { await store.refreshChanges() }
                        }))
                } else if store.files.isEmpty {
                    EmptyStateView(
                        title: "No changes", systemImage: "checkmark.circle",
                        detail: store.scope == .uncommitted
                            ? "Nothing is uncommitted in this worktree."
                            : "This branch matches its base.")
                }
            }
        }
        .background(palette.bg)
        .sheet(isPresented: $committing) { CommitSheet(store: store) }
    }
}

/// The scope picker, in the app's own colours.
///
/// `.pickerStyle(.segmented)` cannot be tinted past its selected-capsule fill,
/// and that capsule is the one thing on the screen that would still read as
/// system grey.
struct SegmentedScope: View {
    @Environment(\.palette) private var palette
    let scope: WorkspaceChangeScope
    let select: (WorkspaceChangeScope) -> Void

    var body: some View {
        HStack(spacing: 5) {
            ForEach([WorkspaceChangeScope.all, .uncommitted], id: \.self) { option in
                let selected = scope == option
                Button {
                    select(option)
                } label: {
                    Text(option == .all ? "All" : "Uncommitted")
                        .font(.system(size: 12, weight: selected ? .semibold : .regular))
                        .foregroundStyle(selected ? palette.accent : palette.textMuted)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 7)
                        .background(
                            selected ? palette.accentWash : palette.surface,
                            in: RoundedRectangle(cornerRadius: Metrics.radiusSmall, style: .continuous))
                        .overlay(
                            RoundedRectangle(cornerRadius: Metrics.radiusSmall, style: .continuous)
                                .strokeBorder(
                                    selected ? palette.accentEdge : palette.border,
                                    lineWidth: Metrics.hairline))
                }
                .buttonStyle(.plain)
            }
        }
    }
}

struct ChangedFileRow: View {
    @Environment(\.palette) private var palette
    let file: DiffFileSummary

    var body: some View {
        HStack(spacing: 9) {
            Text(file.stateLabel)
                .font(.system(size: 11, weight: .semibold, design: .monospaced))
                .frame(width: 20)
                .foregroundStyle(file.untracked ? palette.diffAdd : palette.warning)
            VStack(alignment: .leading, spacing: 2) {
                Text(file.fileName)
                    .font(Typeface.body)
                    .foregroundStyle(palette.textStrong)
                    .lineLimit(1)
                if !file.directory.isEmpty {
                    Text(file.directory)
                        .font(Typeface.monoSmall)
                        .foregroundStyle(palette.textMuted)
                        .lineLimit(1)
                        .truncationMode(.head)
                }
            }
            Spacer(minLength: 6)
            if let additions = file.additions, let deletions = file.deletions {
                HStack(spacing: 5) {
                    Text("+\(additions)").foregroundStyle(palette.diffAdd)
                    Text("−\(deletions)").foregroundStyle(palette.diffDelete)
                }
                .font(Typeface.monoSmall)
            }
        }
        .padding(.horizontal, Metrics.rowInset)
        .padding(.vertical, 9)
        .frame(maxWidth: .infinity, alignment: .leading)
        .contentShape(Rectangle())
        .panel()
    }
}

/// A unified diff, coloured. Monospaced and horizontally scrollable, because
/// wrapping code on a phone makes it unreadable.
struct DiffView: View {
    @Environment(\.palette) private var palette
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
                EmptyStateView(title: "No diff", systemImage: "doc", detail: "Nothing to show for this file.")
            } else {
                // A two-axis ScrollView centres content smaller than the
                // viewport, which pushes a short diff into the middle of the
                // screen under a dead gap. Code reads from the top left.
                ScrollView([.vertical, .horizontal]) {
                    LazyVStack(alignment: .leading, spacing: 0) {
                        ForEach(lines) { line in
                            Text(line.text.isEmpty ? " " : line.text)
                                .font(Typeface.code)
                                .foregroundStyle(colour(for: line.kind))
                                .padding(.horizontal, 8)
                                .padding(.vertical, 1)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .background(background(for: line.kind))
                        }
                        if truncated {
                            Text("… diff truncated at \(DiffParser.lineLimit) lines")
                                .font(Typeface.micro)
                                .foregroundStyle(palette.textMuted)
                                .padding(8)
                        }
                    }
                }
                .defaultScrollAnchor(.topLeading)
                .background(palette.codeSurface)
            }
        }
        .background(palette.bg)
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
        case .addition: palette.diffAdd
        case .deletion: palette.diffDelete
        case .hunkHeader: palette.accent
        case .fileHeader: palette.textMuted
        case .context: palette.codeText
        }
    }

    private func background(for kind: DiffLine.Kind) -> Color {
        switch kind {
        case .addition: palette.diffAddBackground
        case .deletion: palette.diffDeleteBackground
        default: .clear
        }
    }
}

/// Checks, CI runs, and the pull request.
struct ChecksPanel: View {
    @Environment(\.palette) private var palette
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
                                .foregroundStyle(status == "passed" ? palette.diffAdd : palette.warning)
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
                Section { Text(error).font(Typeface.secondary).foregroundStyle(palette.danger) }
            }
        }
        .archductorScreen()
        .tint(palette.accent)
        .refreshable { await store.refreshChecks() }
        .sheet(isPresented: $creatingPR) { CreatePullRequestSheet(store: store) }
    }
}

struct WorkflowRunRow: View {
    @Environment(\.palette) private var palette
    let run: WorkflowRun

    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: icon)
                .foregroundStyle(tint)
            VStack(alignment: .leading, spacing: 2) {
                Text(run.name)
                    .font(Typeface.body)
                    .foregroundStyle(palette.textStrong)
                    .lineLimit(1)
                Text(run.isRunning ? run.status : run.conclusion)
                    .font(Typeface.micro)
                    .foregroundStyle(palette.textMuted)
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
        if run.isRunning { return palette.textMuted }
        return run.isFailure ? palette.diffDelete : palette.diffAdd
    }
}

struct TodosPanel: View {
    @Environment(\.palette) private var palette
    let store: ReviewStore
    @State private var draft = ""

    var body: some View {
        List {
            ForEach(store.todos) { todo in
                HStack(alignment: .top, spacing: 8) {
                    Image(systemName: todo.isOpen ? "circle" : "checkmark.circle.fill")
                        .foregroundStyle(todo.isOpen ? palette.textMuted : palette.diffAdd)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(todo.text)
                            .font(Typeface.body)
                            .foregroundStyle(palette.text)
                        Text(todo.source)
                            .font(Typeface.micro)
                            .foregroundStyle(palette.textMuted)
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
        .archductorScreen()
        .tint(palette.accent)
        .refreshable { await store.refreshTodos() }
        .overlay {
            if store.todos.isEmpty {
                EmptyStateView(
                    title: "No todos", systemImage: "checklist",
                    detail: "Nothing is tracked against this workspace yet.")
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
            .archductorForm()
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
            .archductorForm()
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
