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

UI tests run on a simulator:

```sh
cd ios && xcodegen generate
xcodebuild -project Archductor.xcodeproj -scheme Archductor \
  -destination 'platform=iOS Simulator,name=iPhone 17' test
```

`VisualTourUITests` walks every screen against a live daemon and attaches a
screenshot of each one, which is how a look is reviewed — no assertion says
anything about a colour. It reads only: it opens panels that already exist and
never creates, archives, or sends anything.

```sh
TEST_RUNNER_ARCHDUCTOR_UITEST_ADDRESS=127.0.0.1:7420 \
TEST_RUNNER_ARCHDUCTOR_UITEST_TOKEN="$(cat ~/.local/state/archductor/archcar.token)" \
TEST_RUNNER_ARCHDUCTOR_UITEST_WORKSPACE=<a workspace on that daemon> \
xcodebuild -project Archductor.xcodeproj -scheme Archductor \
  -destination 'platform=iOS Simulator,name=iPhone 17' \
  -resultBundlePath build/tour.xcresult \
  -only-testing:ArchductorUITests/VisualTourUITests test

xcrun xcresulttool export attachments --path build/tour.xcresult \
  --output-path /tmp/tour     # names are in the manifest.json it writes
```

`LiveDaemonUITests` pairs the real app with a real daemon, creates a chat on
it, and renders a transcript. It skips unless you point it at one; `xcodebuild`
only forwards variables prefixed with `TEST_RUNNER_`:

```sh
TEST_RUNNER_ARCHDUCTOR_UITEST_ADDRESS=127.0.0.1:17420 \
TEST_RUNNER_ARCHDUCTOR_UITEST_TOKEN=smoke-token \
TEST_RUNNER_ARCHDUCTOR_UITEST_WORKSPACE=phone-check \
xcodebuild -project Archductor.xcodeproj -scheme Archductor \
  -destination 'platform=iOS Simulator,name=iPhone 17' \
  -only-testing:ArchductorUITests/LiveDaemonUITests test
```

The transcript test needs a seeded conversation. Rather than run a real agent,
insert `provider_events` rows straight into the daemon's database — the
projection reads them the same way either route — and pass
`TEST_RUNNER_ARCHDUCTOR_UITEST_CHAT`, `…_USER_LINE`, and `…_CARD_TITLE` to
match what you seeded.

## Putting it on a phone

```sh
xcrun devicectl list devices            # UDID of the plugged-in phone
make ios-device DEVICE=<udid> TEAM=<team-id>
```

The phone must be unlocked for the install to launch. First launch may need the
developer trusted under Settings → General → VPN & Device Management.

`TEAM` decides how long the build lasts. A personal (free) Apple team signs
builds that stop opening after seven days. A paid Apple Developer Program team
signs against a provisioning profile good for a year, which is the difference
between a phone client you can rely on and one that dies mid-week:

```sh
security find-certificate -c "Apple Development" -p |
  openssl x509 -noout -subject          # OU=... is the team id
```

The app is useless until it can reach a daemon, which means the daemon needs a
listener it can dial: see `docs/guides/phone-access.md`.

## Security

The transport sends a bearer token in cleartext and every client shares one
identity. Only pair with a daemon you reach over Tailscale, WireGuard, or a
trusted LAN. `RotateRemoteToken` revokes every paired client at once.
