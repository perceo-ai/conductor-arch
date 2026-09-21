# Archductor for iOS

A native SwiftUI client for the archcar daemon. Design:
`docs/superpowers/specs/2026-09-20-ios-mobile-app-design.md`.

## Layout

- `ArchcarKit/` — SwiftPM package with all protocol, transport, pairing, and
  state logic. Builds for macOS as well as iOS, so `swift test` runs on the
  host without a simulator.
- `Archductor/` — the SwiftUI app target. Views and platform integration only.
- `tools/` — the theme generator that reads computed values out of the desktop
  CSS bundle.

## Protocol notes

The daemon serves **one request per connection**: it reads a single line after
the token, answers it, and closes. `Subscribe` is the exception — that
connection stays open and carries the event stream. `DaemonSession` is built
around that split, and the live-daemon test suite is what keeps it honest.

## Tests

```sh
make ios-test          # ArchcarKit, including the live-daemon suite
```

The live-daemon suite boots `target/debug/archcar` against a temporary
`XDG_DATA_HOME`/`XDG_STATE_HOME`, so it never touches your real database. It
fails loudly if that binary is missing rather than skipping, because it is the
protocol-drift guard.

## Security

The transport sends a bearer token in cleartext and every client shares one
identity. Only pair with a daemon you reach over Tailscale, WireGuard, or a
trusted LAN. `RotateRemoteToken` revokes every paired client at once.
