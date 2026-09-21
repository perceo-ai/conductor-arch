import ArchcarKit
import SwiftUI

struct PairDaemonView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss

    @State private var label = ""
    @State private var addressText = ""
    @State private var token = ""
    @State private var scanning = false
    @State private var acknowledgedCleartext = false
    @State private var error: String?
    @FocusState private var focusedField: Field?

    private enum Field: Hashable { case label, address, token }

    private var address: DaemonAddress? { DaemonAddress(addressText) }
    private var needsAcknowledgement: Bool { address.map { !$0.isLoopback } ?? false }
    private var canSave: Bool {
        address != nil && !token.isEmpty && (!needsAcknowledgement || acknowledgedCleartext)
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Button {
                        scanning = true
                    } label: {
                        Label("Scan pairing code", systemImage: "qrcode.viewfinder")
                    }
                } footer: {
                    Text("Desktop app → Settings → Clients → Show pairing code.")
                }

                Section("Or enter it by hand") {
                    TextField("Name", text: $label)
                        .focused($focusedField, equals: .label)
                    TextField("Address (host or host:port)", text: $addressText)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .keyboardType(.URL)
                        .focused($focusedField, equals: .address)
                    SecureField("Token", text: $token)
                        .focused($focusedField, equals: .token)
                        // Opt out of password AutoFill. iOS otherwise offers to
                        // save this into the (iCloud-synced) keychain, which
                        // would push a daemon token onto every device on the
                        // account -- the opposite of the device-only storage
                        // the app deliberately uses for it.
                        .textContentType(.oneTimeCode)
                }

                if needsAcknowledgement {
                    Section {
                        // Short label, long explanation in the footer: a toggle
                        // whose label is three lines of warning is hard to read
                        // and hard to hit.
                        Toggle("I understand the risk", isOn: $acknowledgedCleartext)
                            .accessibilityIdentifier("cleartext-acknowledgement")
                    } footer: {
                        Text("This token is sent unencrypted. Anyone who can reach \(address?.description ?? "this address") can run commands on that machine. Use Tailscale, WireGuard, or a network you trust.")
                    }
                }

                if let error {
                    Section {
                        Text(error)
                            .foregroundStyle(.red)
                            .font(.footnote)
                    }
                }
            }
            .navigationTitle("Pair daemon")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") { Task { await save() } }
                        .disabled(!canSave)
                }
                // A URL keyboard has no return key that dismisses, and the
                // acknowledgement sits below the fields — without this there is
                // no way to reach it once the keyboard is up.
                ToolbarItemGroup(placement: .keyboard) {
                    Spacer()
                    Button("Done") { focusedField = nil }
                        .accessibilityIdentifier("dismiss-keyboard")
                }
            }
            .sheet(isPresented: $scanning) {
                NavigationStack {
                    QRScannerView { scanned in
                        scanning = false
                        apply(scanned)
                    }
                    .ignoresSafeArea()
                    .navigationTitle("Scan pairing code")
                    .navigationBarTitleDisplayMode(.inline)
                    .toolbar {
                        ToolbarItem(placement: .cancellationAction) {
                            Button("Cancel") { scanning = false }
                        }
                    }
                }
            }
        }
    }

    private func apply(_ scanned: String) {
        do {
            let payload = try PairingPayload.decode(scanned)
            label = payload.label
            addressText = payload.address.description
            token = payload.token
            error = nil
        } catch PairingError.unsupportedVersion(let version) {
            error = "That code is version \(version); this app understands version \(PairingPayload.currentVersion). Update the app."
        } catch _ {
            // Named so the implicit `error` binding does not shadow the state
            // property this is trying to write.
            error = "That does not look like an Archductor pairing code."
        }

    }

    private func save() async {
        guard let address else { return }
        do {
            let daemon = try await model.directory.add(label: label, address: address, token: token)
            await model.refreshSavedList()
            dismiss()
            await model.activate(daemon)
        } catch let failure {
            error = "Could not save: \(failure)"
        }
    }
}
