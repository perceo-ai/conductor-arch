import ArchcarKit
import SwiftUI

/// The workspace tree, one level at a time.
struct FilesPanel: View {
    let store: FilesStore
    var prefix: String = ""

    private var entries: (directories: [String], files: [String]) {
        store.entries(under: prefix)
    }

    var body: some View {
        List {
            ForEach(entries.directories, id: \.self) { directory in
                NavigationLink {
                    FilesPanel(store: store, prefix: joined(directory))
                        .navigationTitle(directory)
                } label: {
                    Label(directory, systemImage: "folder")
                }
            }
            ForEach(entries.files, id: \.self) { file in
                NavigationLink {
                    FileEditorView(store: store, path: joined(file))
                } label: {
                    Label(file, systemImage: "doc.text")
                }
            }
        }
        .listStyle(.plain)
        .refreshable { await store.refresh() }
        .overlay {
            if store.isLoading && store.paths.isEmpty {
                ProgressView()
            } else if entries.directories.isEmpty && entries.files.isEmpty {
                ContentUnavailableView("No files", systemImage: "folder")
            }
        }
        .task {
            if store.paths.isEmpty { await store.refresh() }
        }
    }

    private func joined(_ component: String) -> String {
        prefix.isEmpty ? component : "\(prefix)/\(component)"
    }
}

/// Reading, and editing, one file.
struct FileEditorView: View {
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
                ProgressView()
            } else {
                TextEditor(text: $text)
                    .font(.system(.footnote, design: .monospaced))
                    .autocorrectionDisabled()
                    .textInputAutocapitalization(.never)
                    .accessibilityIdentifier("file-editor")
            }
        }
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
                                .font(.system(size: 11, design: .monospaced))
                                .textSelection(.enabled)
                                .id(index)
                        }
                    }
                    .padding(8)
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
                .defaultScrollAnchor(.topLeading)
                .onChange(of: store.screen) { _, _ in
                    guard !lines.isEmpty else { return }
                    // bottomLeading, not bottom: anchoring on the centre drags
                    // the horizontal offset along with it and cuts off the left
                    // of every line.
                    proxy.scrollTo(lines.count - 1, anchor: .bottomLeading)
                }
            }

            Divider()

            HStack(spacing: 8) {
                // No control key on a phone keyboard, and stopping a runaway
                // command is the main reason to open a terminal from one.
                Button("^C") { Task { await store.sendControl("C") } }
                    .buttonStyle(.bordered)
                    .accessibilityIdentifier("terminal-ctrl-c")

                TextField("Command", text: $command)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .font(.system(.footnote, design: .monospaced))
                    .accessibilityIdentifier("terminal-input")
                    .onSubmit(run)

                Button("Run", action: run)
                    .disabled(command.trimmingCharacters(in: .whitespaces).isEmpty)
            }
            .padding(8)
            .background(.bar)
        }
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
