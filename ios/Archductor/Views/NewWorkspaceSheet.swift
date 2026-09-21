import ArchcarKit
import SwiftUI

/// Creating a workspace, in the four shapes the daemon supports.
struct NewWorkspaceSheet: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    let repository: RepositorySummary

    @State private var kind: Kind = .prompt
    @State private var name = ""
    @State private var branch = ""
    @State private var prompt = ""
    @State private var number = ""
    @State private var linearID = ""
    @State private var working = false
    @State private var error: String?

    enum Kind: String, CaseIterable, Identifiable {
        case prompt = "Task"
        case branch = "Branch"
        case issue = "Issue"
        case pr = "PR"
        var id: String { rawValue }
    }

    private var canCreate: Bool {
        switch kind {
        case .prompt: !prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        case .branch:
            !name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                && !branch.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        case .issue, .pr: Int(number.trimmingCharacters(in: .whitespaces)) != nil
        }
    }

    var body: some View {
        NavigationStack {
            Form {
                Picker("From", selection: $kind) {
                    ForEach(Kind.allCases) { Text($0.rawValue).tag($0) }
                }
                .pickerStyle(.segmented)

                switch kind {
                case .prompt:
                    Section {
                        TextField("What should the agent do?", text: $prompt, axis: .vertical)
                            .lineLimit(3...8)
                            .accessibilityIdentifier("workspace-prompt")
                    } footer: {
                        // The naming pipeline renames the workspace from the
                        // first message, so a typed name would be overwritten.
                        Text("Archductor names the workspace and branch from the task.")
                    }
                case .branch:
                    Section {
                        TextField("Name", text: $name)
                            .accessibilityIdentifier("workspace-name")
                        TextField("Branch", text: $branch)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                            .accessibilityIdentifier("workspace-branch")
                    }
                case .issue:
                    Section {
                        TextField("Issue number", text: $number)
                            .keyboardType(.numberPad)
                    } footer: {
                        Text("Needs gh auth on the machine running the daemon.")
                    }
                case .pr:
                    Section {
                        TextField("Pull request number", text: $number)
                            .keyboardType(.numberPad)
                    } footer: {
                        Text("Needs gh auth on the machine running the daemon.")
                    }
                }

                if let error {
                    Section { Text(error).font(.footnote).foregroundStyle(.red) }
                }
            }
            .navigationTitle("New workspace")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Create") { Task { await create() } }
                        .disabled(!canCreate || working)
                }
                ToolbarItemGroup(placement: .keyboard) {
                    Spacer()
                    Button("Done") { hideKeyboard() }
                        .accessibilityIdentifier("dismiss-keyboard")
                }
            }
        }
    }

    private func hideKeyboard() {
        UIApplication.shared.sendAction(
            #selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil)
    }

    private func create() async {
        guard let store = model.workspaces else { return }
        working = true
        defer { working = false }

        let request: WorkspacesStore.CreateRequest
        switch kind {
        case .prompt:
            request = .prompt(prompt.trimmingCharacters(in: .whitespacesAndNewlines))
        case .branch:
            request = .branch(
                name: name.trimmingCharacters(in: .whitespacesAndNewlines),
                branch: branch.trimmingCharacters(in: .whitespacesAndNewlines),
                baseRef: nil)
        case .issue:
            guard let value = Int(number.trimmingCharacters(in: .whitespaces)) else { return }
            request = .issue(number: value)
        case .pr:
            guard let value = Int(number.trimmingCharacters(in: .whitespaces)) else { return }
            request = .pullRequest(number: value)
        }

        if await store.createWorkspace(in: repository.name, request) != nil {
            dismiss()
        } else {
            error = store.lastError ?? "The daemon could not create that workspace."
        }
    }
}

struct AddRepositorySheet: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss

    @State private var mode: Mode = .existing
    @State private var path = ""
    @State private var url = ""
    @State private var dest = ""
    @State private var name = ""
    @State private var working = false
    @State private var error: String?

    enum Mode: String, CaseIterable, Identifiable {
        case existing = "On disk"
        case clone = "Clone"
        var id: String { rawValue }
    }

    var body: some View {
        NavigationStack {
            Form {
                Picker("Source", selection: $mode) {
                    ForEach(Mode.allCases) { Text($0.rawValue).tag($0) }
                }
                .pickerStyle(.segmented)

                switch mode {
                case .existing:
                    Section {
                        TextField("Path on the daemon's machine", text: $path)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                        TextField("Name (optional)", text: $name)
                    } footer: {
                        // The path is resolved by the daemon, not the phone —
                        // easy to misread when you are typing it remotely.
                        Text("Paths are on the machine running the daemon, not on this phone.")
                    }
                case .clone:
                    Section {
                        TextField("Git URL", text: $url)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                        TextField("Destination directory", text: $dest)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                        TextField("Name (optional)", text: $name)
                    }
                }

                if let error {
                    Section { Text(error).font(.footnote).foregroundStyle(.red) }
                }
            }
            .navigationTitle("Add repository")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Add") { Task { await add() } }.disabled(working || !canAdd)
                }
            }
        }
    }

    private var canAdd: Bool {
        switch mode {
        case .existing: !path.trimmingCharacters(in: .whitespaces).isEmpty
        case .clone:
            !url.trimmingCharacters(in: .whitespaces).isEmpty
                && !dest.trimmingCharacters(in: .whitespaces).isEmpty
        }
    }

    private func add() async {
        guard let store = model.workspaces else { return }
        working = true
        defer { working = false }
        let label = name.trimmingCharacters(in: .whitespacesAndNewlines)
        let ok: Bool
        switch mode {
        case .existing:
            ok = await store.addRepository(
                path: path.trimmingCharacters(in: .whitespaces), name: label.isEmpty ? nil : label)
        case .clone:
            ok = await store.cloneRepository(
                url: url.trimmingCharacters(in: .whitespaces),
                dest: dest.trimmingCharacters(in: .whitespaces),
                name: label.isEmpty ? nil : label)
        }
        if ok { dismiss() } else { error = store.lastError ?? "The daemon rejected that repository." }
    }
}
