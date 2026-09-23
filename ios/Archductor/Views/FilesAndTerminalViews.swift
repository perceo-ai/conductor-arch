import ArchcarKit
import SwiftUI

/// The workspace tree, one level at a time.
struct FilesPanel: View {
    @Environment(\.palette) private var palette
    let store: FilesStore
    var prefix: String = ""

    private var entries: (directories: [String], files: [String]) {
        store.entries(under: prefix)
    }

    var body: some View {
        ScrollView {
            LazyVStack(spacing: 4) {
                ForEach(entries.directories, id: \.self) { directory in
                    NavigationLink {
                        FilesPanel(store: store, prefix: joined(directory))
                            .navigationTitle(directory)
                    } label: {
                        entryRow(directory, systemImage: "folder", isDirectory: true)
                    }
                    .buttonStyle(.plain)
                }
                ForEach(entries.files, id: \.self) { file in
                    NavigationLink {
                        FileEditorView(store: store, path: joined(file))
                    } label: {
                        entryRow(file, systemImage: "doc.text", isDirectory: false)
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(.horizontal, Metrics.pageInset)
            .padding(.vertical, 12)
        }
        .archductorScreen()
        .refreshable { await store.refresh() }
        .overlay {
            if store.isLoading && store.paths.isEmpty {
                ProgressView().tint(palette.textMuted)
            } else if entries.directories.isEmpty && entries.files.isEmpty {
                EmptyStateView(
                    title: "No files", systemImage: "folder",
                    detail: "This directory is empty.")
            }
        }
        .task {
            if store.paths.isEmpty { await store.refresh() }
        }
    }

    private func entryRow(_ name: String, systemImage: String, isDirectory: Bool) -> some View {
        HStack(spacing: 8) {
            Image(systemName: systemImage)
                .imageScale(.small)
                .foregroundStyle(isDirectory ? palette.accent : palette.textMuted)
                .frame(width: 16)
            Text(name)
                .font(Typeface.mono)
                .foregroundStyle(isDirectory ? palette.textStrong : palette.text)
                .lineLimit(1)
                .truncationMode(.middle)
            Spacer(minLength: 6)
            if isDirectory {
                Image(systemName: "chevron.right")
                    .font(.system(size: 10, weight: .semibold))
                    .foregroundStyle(palette.textMuted)
            }
        }
        .padding(.horizontal, Metrics.rowInset)
        .padding(.vertical, 8)
        .frame(maxWidth: .infinity, alignment: .leading)
        .contentShape(Rectangle())
        .panel(fill: \.surface)
    }

    private func joined(_ component: String) -> String {
        prefix.isEmpty ? component : "\(prefix)/\(component)"
    }
}

/// Reading, and editing, one file.
struct FileEditorView: View {
    @Environment(\.palette) private var palette
    let store: FilesStore
    let path: String

    @State private var text = ""
    @State private var original = ""
    @State private var loading = true
    @State private var saving = false
    @State private var saveError: String?

    private var isDirty: Bool { text != original }

    var body: some View {
        Group {
            if loading {
                ProgressView().tint(palette.textMuted)
            } else {
                TextEditor(text: $text)
                    .font(Typeface.code)
                    .foregroundStyle(palette.codeText)
                    .scrollContentBackground(.hidden)
                    .autocorrectionDisabled()
                    .textInputAutocapitalization(.never)
                    .accessibilityIdentifier("file-editor")
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(palette.codeSurface)
        .tint(palette.accent)
        .navigationTitle(path.split(separator: "/").last.map(String.init) ?? path)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button("Save") {
                    saving = true
                    Task {
                        if await store.write(path, content: text) {
                            original = text
                        } else {
                            saveError = store.lastError ?? "The daemon rejected the write."
                        }
                        saving = false
                    }
                }
                // Saving an unchanged file would still rewrite it on disk and
                // show up as a change in the review panel.
                .disabled(!isDirty || saving)
            }
            ToolbarItemGroup(placement: .keyboard) {
                Spacer()
                Button("Done") {
                    UIApplication.shared.sendAction(
                        #selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil)
                }
            }
        }
        .alert("Could not save", isPresented: Binding(
            get: { saveError != nil }, set: { if !$0 { saveError = nil } })) {
            Button("OK", role: .cancel) { saveError = nil }
        } message: {
            Text(saveError ?? "")
        }
        .task {
            text = await store.read(path) ?? ""
            original = text
            loading = false
        }
    }
}

/// A shell in the workspace.
///
/// The daemon renders the VT100 screen to text, so this shows that text and
/// sends keystrokes back — enough to read output and run the occasional
/// command, which is what a phone is for.
struct TerminalPanel: View {
    @Environment(\.palette) private var palette
    let store: TerminalStore
    @State private var command = ""

    private var lines: [String] {
        let screen = store.displayScreen
        return screen.isEmpty
            ? ["starting a shell…"]
            : screen.components(separatedBy: "\n")
    }

    var body: some View {
        VStack(spacing: 0) {
            // Explicit scroll-to-bottom rather than a scroll anchor: with the
            // keyboard up, an anchored two-axis ScrollView keeps its full
            // height and parks the output underneath the keyboard.
            ScrollViewReader { proxy in
                ScrollView([.vertical, .horizontal]) {
                    LazyVStack(alignment: .leading, spacing: 0) {
                        ForEach(Array(lines.enumerated()), id: \.offset) { index, line in
                            Text(line.isEmpty ? " " : line)
                                .font(Typeface.monoSmall)
                                .foregroundStyle(palette.codeText)
                                .textSelection(.enabled)
                                .id(index)
                        }
                    }
                    .padding(8)
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
                .background(palette.codeSurface)
                .defaultScrollAnchor(.topLeading)
                .onChange(of: store.screen) { _, _ in
                    guard !lines.isEmpty else { return }
                    // bottomLeading, not bottom: anchoring on the centre drags
                    // the horizontal offset along with it and cuts off the left
                    // of every line.
                    proxy.scrollTo(lines.count - 1, anchor: .bottomLeading)
                }
            }

            Rectangle().fill(palette.border).frame(height: Metrics.hairline)

            HStack(spacing: 8) {
                // No control key on a phone keyboard, and stopping a runaway
                // command is the main reason to open a terminal from one.
                Button("^C") { Task { await store.sendControl("C") } }
                    .buttonStyle(QuietButtonStyle())
                    .accessibilityIdentifier("terminal-ctrl-c")

                TextField("Command", text: $command)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .font(Typeface.mono)
                    .foregroundStyle(palette.text)
                    .padding(.horizontal, 9)
                    .padding(.vertical, 7)
                    .panel(fill: \.surfaceRaised)
                    .accessibilityIdentifier("terminal-input")
                    .onSubmit(run)

                Button("Run", action: run)
                    .buttonStyle(AccentButtonStyle())
                    .disabled(command.trimmingCharacters(in: .whitespaces).isEmpty)
            }
            .padding(.horizontal, Metrics.pageInset)
            .padding(.vertical, 8)
            .background(palette.surface)
        }
        .background(palette.bg)
        .task {
            await store.start()
            await store.refreshScreen()
        }
        .task { await store.observe() }
    }

    private func run() {
        let text = command
        command = ""
        Task { await store.send(text) }
    }
}
