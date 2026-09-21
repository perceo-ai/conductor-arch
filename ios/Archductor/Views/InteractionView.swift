import ArchcarKit
import SwiftUI

/// Answering a blocked agent.
///
/// Three shapes behind one screen, because the daemon models them as one
/// record: a permission prompt, a batch of questions, and a plan approval.
struct InteractionView: View {
    let store: ChatStore
    let interaction: ProviderInteraction

    @Environment(\.dismiss) private var dismiss
    @State private var selections: [String: Set<String>] = [:]
    @State private var otherText: [String: String] = [:]
    @State private var denyReason = ""
    @State private var working = false

    var body: some View {
        Form {
            Section {
                Text(interaction.title).font(.headline)
                if !interaction.detail.isEmpty {
                    Text(interaction.detail)
                        .font(.caption.monospaced())
                        .textSelection(.enabled)
                }
            } header: {
                Text(interaction.kindLabel)
            }

            switch interaction.kind {
            case .userQuestion:
                questionSections
            case .permission, .planApproval, .unknown:
                approvalSection
            }
        }
        .navigationTitle("Needs you")
        .navigationBarTitleDisplayMode(.inline)
        .disabled(working)
    }

    @ViewBuilder
    private var approvalSection: some View {
        Section {
            Button("Approve") { resolve(.approve) }
            // Codex and Claude both support "stop asking me this for now", and
            // on a phone that is the difference between one tap and twenty.
            Button("Approve for this session") { resolve(.approveForSession) }
        }
        Section {
            TextField("Reason (optional)", text: $denyReason)
            Button("Deny", role: .destructive) {
                let reason = denyReason.trimmingCharacters(in: .whitespacesAndNewlines)
                resolve(.deny(reason: reason.isEmpty ? nil : reason))
            }
        } footer: {
            Text("The agent sees the reason and can try another way.")
        }
    }

    @ViewBuilder
    private var questionSections: some View {
        ForEach(interaction.questions) { question in
            Section {
                ForEach(question.options, id: \.label) { option in
                    Button {
                        toggle(option.label, in: question)
                    } label: {
                        HStack(alignment: .top) {
                            Image(systemName: isSelected(option.label, in: question)
                                ? (question.multiSelect ? "checkmark.square.fill" : "largecircle.fill.circle")
                                : (question.multiSelect ? "square" : "circle"))
                            VStack(alignment: .leading, spacing: 2) {
                                Text(option.label)
                                if !option.description.isEmpty {
                                    Text(option.description)
                                        .font(.caption)
                                        .foregroundStyle(.secondary)
                                }
                            }
                        }
                    }
                    .buttonStyle(.plain)
                }
                if question.allowOther {
                    TextField("Something else…", text: Binding(
                        get: { otherText[question.id] ?? "" },
                        set: { otherText[question.id] = $0 }))
                }
            } header: {
                Text(question.header.isEmpty ? question.question : question.header)
            } footer: {
                if !question.header.isEmpty { Text(question.question) }
            }
        }

        Section {
            Button("Send answer") { resolve(.answer(answers: answers())) }
                .disabled(answers().isEmpty)
        }
    }

    private func isSelected(_ label: String, in question: InteractionQuestion) -> Bool {
        selections[question.id]?.contains(label) ?? false
    }

    private func toggle(_ label: String, in question: InteractionQuestion) {
        var current = selections[question.id] ?? []
        if question.multiSelect {
            if current.contains(label) { current.remove(label) } else { current.insert(label) }
        } else {
            current = current.contains(label) ? [] : [label]
        }
        selections[question.id] = current
    }

    /// Free text counts as an answer on its own, which is what `allow_other`
    /// means — otherwise "Something else…" would be a box that does nothing.
    private func answers() -> [InteractionAnswer] {
        interaction.questions.compactMap { question in
            var values = Array(selections[question.id] ?? []).sorted()
            let other = (otherText[question.id] ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            if !other.isEmpty { values.append(other) }
            guard !values.isEmpty else { return nil }
            return InteractionAnswer(questionID: question.id, values: values)
        }
    }

    private func resolve(_ resolution: InteractionResolution) {
        working = true
        Task {
            await store.resolve(interaction, with: resolution)
            working = false
            dismiss()
        }
    }
}
