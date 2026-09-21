import ArchcarKit
import SwiftUI

struct DaemonsView: View {
    @Environment(AppModel.self) private var model
    @State private var pairing = false

    var body: some View {
        NavigationStack {
            List {
                Section("Daemons") {
                    ForEach(model.saved) { daemon in
                        Button {
                            Task { await model.activate(daemon) }
                        } label: {
                            HStack {
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(daemon.label)
                                        .foregroundStyle(.primary)
                                    // The address is shown, not hidden behind
                                    // the label: pairing with the wrong machine
                                    // should be visible now, not discovered later.
                                    Text(daemon.address.description)
                                        .font(.caption)
                                        .foregroundStyle(.secondary)
                                }
                                Spacer()
                                if daemon.id == model.activeDaemon?.id {
                                    Image(systemName: "checkmark")
                                        .foregroundStyle(.tint)
                                }
                            }
                        }
                        .swipeActions {
                            Button("Forget", role: .destructive) {
                                Task {
                                    try? await model.directory.remove(id: daemon.id)
                                    await model.refreshSavedList()
                                }
                            }
                        }
                    }
                    Button("Pair a daemon…") { pairing = true }
                }

                Section {
                    Label {
                        Text("The pairing token travels unencrypted and gives full control of that machine. Only connect over Tailscale, WireGuard, or a network you trust.")
                    } icon: {
                        Image(systemName: "lock.open.trianglebadge.exclamationmark")
                    }
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                }
            }
            .navigationTitle("More")
            .sheet(isPresented: $pairing) { PairDaemonView() }
        }
    }
}
