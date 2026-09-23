import ArchcarKit
import SwiftUI

struct DaemonsView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.palette) private var palette
    @AppStorage(AppearancePreference.storageKey) private var appearance = AppearancePreference.dark
    @State private var pairing = false

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    daemons
                    appearanceSection
                    securityNote
                }
                .padding(.horizontal, Metrics.pageInset)
                .padding(.vertical, 14)
            }
            .archductorScreen()
            .navigationTitle("More")
            .navigationBarTitleDisplayMode(.inline)
            .sheet(isPresented: $pairing) { PairDaemonView() }
        }
    }

    private var daemons: some View {
        VStack(alignment: .leading, spacing: 7) {
            SectionHeading(text: "Daemons")
            VStack(spacing: 6) {
                ForEach(model.saved) { daemon in
                    Button {
                        Task { await model.activate(daemon) }
                    } label: {
                        daemonRow(daemon)
                    }
                    .buttonStyle(.plain)
                    .contextMenu {
                        Button("Forget", role: .destructive) {
                            Task {
                                try? await model.directory.remove(id: daemon.id)
                                await model.refreshSavedList()
                            }
                        }
                    }
                }
                Button {
                    pairing = true
                } label: {
                    HStack(spacing: 6) {
                        Image(systemName: "qrcode.viewfinder").imageScale(.small)
                        Text("Pair a daemon…")
                        Spacer()
                    }
                    .font(Typeface.secondary)
                    .foregroundStyle(palette.accent)
                    .padding(.horizontal, Metrics.rowInset)
                    .padding(.vertical, 10)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .panel(fill: \.surface)
            }
        }
    }

    private func daemonRow(_ daemon: SavedDaemon) -> some View {
        let active = daemon.id == model.activeDaemon?.id
        return HStack(spacing: 9) {
            VStack(alignment: .leading, spacing: 3) {
                Text(daemon.label)
                    .font(Typeface.bodyStrong)
                    .foregroundStyle(palette.textStrong)
                    .lineLimit(1)
                // The address is shown, not hidden behind the label: pairing
                // with the wrong machine should be visible now, not discovered
                // later.
                Text(daemon.address.description)
                    .font(Typeface.monoSmall)
                    .foregroundStyle(palette.textMuted)
                    .lineLimit(1)
            }
            Spacer(minLength: 6)
            if active {
                Image(systemName: "checkmark")
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(palette.accent)
            }
        }
        .padding(.horizontal, Metrics.rowInset)
        .padding(.vertical, 10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .contentShape(Rectangle())
        .panel(
            fill: active ? \.surfaceSelected : \.surfaceRaised,
            border: active ? \.accentEdge : \.border)
    }

    private var appearanceSection: some View {
        VStack(alignment: .leading, spacing: 7) {
            SectionHeading(text: "Appearance")
            HStack(spacing: 5) {
                ForEach(AppearancePreference.allCases) { option in
                    let selected = appearance == option
                    Button {
                        appearance = option
                    } label: {
                        Text(option.label)
                            .font(.system(size: 12, weight: selected ? .semibold : .regular))
                            .foregroundStyle(selected ? palette.accent : palette.textMuted)
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 8)
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

    private var securityNote: some View {
        HStack(alignment: .top, spacing: 8) {
            Image(systemName: "lock.open.trianglebadge.exclamationmark")
                .imageScale(.small)
            Text(
                "The pairing token travels unencrypted and gives full control of that machine. Only connect over Tailscale, WireGuard, or a network you trust."
            )
        }
        .font(Typeface.secondary)
        .foregroundStyle(palette.tint(.warning).ink)
        .padding(Metrics.rowInset)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            palette.tint(.warning).fill,
            in: RoundedRectangle(cornerRadius: Metrics.radiusSmall, style: .continuous))
    }
}
