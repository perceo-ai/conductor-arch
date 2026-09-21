# Archductor for iOS — design

Date: 2026-09-20
Status: approved design, not yet implemented

## Goal

A native iOS app that connects to any archcar daemon the user has configured,
looks and behaves like Archductor, and reaches near-parity with the Electron
desktop surface: drive agents, review work, manage workspaces, read terminals
and files, and get notified when an agent needs a human.

The phone is a first-class client of the same daemon, not a companion viewer.
Anything the desktop can ask archcar for, the phone can ask for too.

## Non-goals

- No second source of truth. The app holds no product logic the daemon does
  not already own; it renders daemon state and sends daemon requests.
- No offline write queue. Queued input is a daemon concept
  (`QueueChatInput`); the app does not invent a second queue.
- No presentation state on the daemon. Layout presets, panel geometry, and
  tab selection stay device-local, matching the existing strategy non-goal.
- No editing of repository settings files beyond what the daemon exposes as
  RPCs today.

## Decisions taken

These were settled in brainstorming and are not open for re-litigation during
implementation:

1. **Native SwiftUI**, not Capacitor, React Native, or a PWA.
2. **Plain TCP + bearer token** transport, with a trusted network assumed
   (Tailscale/WireGuard/LAN). No TLS work in archcar for this project.
3. **Near-parity scope**, delivered in phases (see Phasing).
4. **TestFlight distribution with APNs push**, so alerts arrive with the app
   closed.
5. **Tab bar + drill-in navigation**, not a literal sidebar mirror.

## What already exists

Verified in this repository before writing this spec:

- `crates/core/src/archcar/protocol.rs` — `ArchcarRequest` (~190 variants),
  `ArchcarResponse`, and `ArchcarEvent` (19 variants). All three are
  internally tagged: `#[serde(tag = "type", rename_all = "snake_case")]`.
  Every message is wrapped in `RpcEnvelope { id, payload }`.
- `crates/core/src/archcar/remote.rs` — a TCP listener on
  `ARCHDUCTOR_ARCHCAR_LISTEN` (bare port means loopback, default port 7420),
  guarded by a shared token that the client sends as the first line. A bad
  token gets a well-formed error envelope, not a decode failure. The token
  lives at `<state_dir>/archcar.token`.
- `crates/core/src/archcar/server.rs` — `Subscribe` is only valid on a
  persistent connection; the server answers it with a snapshot of running
  sessions and then streams `RpcEnvelope<ArchcarEvent>` lines forever.
  On any other connection `Subscribe` returns
  `"subscribe must use a persistent connection"`.
- `GetRemoteAccess` returns the listen address and the token; `InstallService`
  accepts a `listen` address; `GetServiceStatus` reports it; and
  `RotateRemoteToken` replaces it. Pairing therefore needs **no new daemon
  RPC**.
- `desktop/` — Electron + Solid.js, already multi-daemon: saved clients carry
  `{ id, label, address }` with the token held in the Electron main process
  and never exposed to the renderer.
- Styling is 129 CSS custom properties spread across `desktop/src/styles`
  in four override passes (`neutral`, `theme`, `charcoal`, `polish`, `final`),
  where import order is load-bearing.

## Architecture

### Repository layout

```
ios/
  ArchcarKit/                       SwiftPM package — all logic, no views
    Sources/ArchcarKit/
      Transport/                    socket, framing, handshake, reconnect
      Protocol/                     request structs, response + event types
      Session/                      DaemonSession actor, request routing
      Stores/                       observable state mirroring desktop stores
      Theme/                        generated design tokens
    Tests/ArchcarKitTests/          `swift test`, no simulator required
  Archductor/                       Xcode app project (SwiftUI views only)
  ArchductorUITests/                XCUITest simulator smoke
  tools/
    generate-theme.mjs              CSS token dump -> Theme.swift
```

Logic lives in `ArchcarKit` so it is testable in seconds without Xcode or a
simulator. The app target holds views, navigation, and platform integration
(Keychain, camera, notifications) only.

### Transport

Two sockets per active daemon, because `Subscribe` occupies its connection:

- **Command socket** — request/response. Each request is
  `RpcEnvelope { id: UUID, payload }` on one line; responses are matched back
  by `id` to a suspended continuation.
- **Event socket** — sends `Subscribe` once, then reads event envelopes until
  the connection dies.

Both send the token as the first line before anything else. A failed handshake
surfaces as `archcar authentication failed`, which the app renders as "token
rejected — re-pair with this daemon" rather than a network error.

Reconnect uses exponential backoff capped at 30s, restarted immediately on
`scenePhase` returning to `.active` and on network path changes
(`NWPathMonitor`). On reconnect the app refetches every visible projection; it
does not attempt to replay missed events, because events carry only IDs and
the projections are authoritative.

### Protocol layer

The Rust request enum has ~190 variants across types declared in `workspace.rs`,
`workspace_intel.rs`, `background_tasks.rs`, `service.rs`, `doctor.rs`, and
more. Two approaches were rejected:

- **Codegen** (`typeshare`, `schemars`): requires annotating every type in core,
  invasive for a client-side concern.
- **One giant Swift enum** mirroring `ArchcarRequest`: 190 cases the app mostly
  never sends, all of which must be maintained.

Instead: one small `Encodable` struct per RPC the app actually uses (~70 by the
end of P4), each declaring its own `type` discriminator. Responses decode into
typed structs; an unrecognized `type` decodes to `.unknown(String)` instead of
throwing, so a newer daemon never bricks an older phone. All 19 events are
typed, since they are few and thin.

Drift is caught behaviourally rather than structurally: an `ArchcarKitTests`
suite builds the Rust `archcar` binary, starts it against a temporary
`ARCHDUCTOR_*` root with `ARCHDUCTOR_ARCHCAR_LISTEN` set to an ephemeral port,
and round-trips every request the app can send plus the event stream. A renamed
or retyped field in core fails that test.

### State

- `DaemonSession` is an `actor` owning both sockets, the in-flight request
  table, and an `AsyncStream<ArchcarEvent>`.
- Stores are `@Observable` classes mirroring the desktop stores one-for-one:
  `WorkspacesStore`, `ThreadsStore`, `ChatStore`, `ChangesStore`, `TasksStore`,
  `BackgroundTasksStore`. Each subscribes to the event stream and refetches the
  projections that event invalidates, following the same mapping documented in
  `docs/app-state-refresh-map.md`. Keeping that mapping shared is what stops
  phone and desktop from disagreeing about when something is stale.
- Read results are cached to disk per daemon so the app opens on last-known
  state rather than a spinner. Cached views are visibly marked stale while the
  socket is down, and mutating controls are disabled — there is no offline
  outbox.

### Connection model and pairing

The app stores N daemons: `{ id, label, address, tokenRef }`. Tokens live in
the Keychain (`kSecAttrAccessibleWhenUnlockedThisDeviceOnly`), never in
`UserDefaults`, never in logs, never in crash reports.

Pairing has two paths:

1. **QR from desktop (primary).** A new Settings card in the Electron app calls
   `GetRemoteAccess`, renders a QR encoding
   `{"v":1,"label":…,"address":"host:port","token":…}`, and the phone scans it.
   When `GetServiceStatus` reports no listen address, the card offers to enable
   phone access by calling `InstallService` with a `listen` value, then shows
   the QR. This needs no new daemon RPC.
2. **Manual entry (fallback).** Address plus token typed by hand, for a daemon
   whose desktop app is not in front of you.

The QR payload contains a live credential. The desktop card therefore renders
it only on explicit reveal, hides it on blur, and warns that anyone who
photographs the code gains full control of that machine.
`RotateRemoteToken` is offered next to it as the revocation path.

### Security posture (stated plainly)

This transport sends a bearer token in cleartext and gives every client the same
identity. Anyone who can observe or reach the port can take the token and drive
the daemon: run commands, read the repository, push branches. That is an
accepted trade for this project, on the condition that the listener is only ever
exposed on a trusted network.

The app enforces informed consent rather than pretending the risk away:

- The pairing screen states, before saving, that the token travels unencrypted
  and that the daemon should be reached over Tailscale, WireGuard, or a trusted
  LAN.
- A non-loopback address requires an explicit acknowledgement tap.
- The daemon list shows the address of each saved daemon so a mistake is
  visible rather than hidden behind a label.
- A `RotateRemoteToken` action is reachable from the app, so a lost phone can be
  cut off from the phone that remains.

TLS and per-client identity are explicitly deferred. If the threat model
changes, `remote.rs` is the single place that changes, and the app gains a
pinned-fingerprint field in the pairing payload.

## Look and feel

"Looks like Archductor" is carried by tokens, not by screenshots. Because the
desktop CSS resolves its final values through four override passes where import
order matters, hand-transcribing values from source files would produce wrong
colours. `ios/tools/generate-theme.mjs` loads the **built** CSS bundle in
headless Chromium, reads the computed value of every custom property in both
dark and light themes, and emits `Theme.swift` with colour, type scale, spacing,
radius, and motion tokens. The script is checked in and rerun whenever desktop
restyles; its output is committed so the build needs no browser.

Adaptations the phone makes on purpose:

- Type scale honours Dynamic Type, anchored so the default size matches the
  desktop's density rather than iOS defaults.
- Status vocabulary is identical: the same status dots (including `blocked`
  outranking running/review), the same agent-count, open/blocked-task, and PR
  chips as the desktop left rail.
- Dark theme first; light follows from the same token dump.
- Touch targets are at least 44pt, which means some desktop affordances become
  context menus or swipe actions rather than hover controls.

## Navigation

Bottom tab bar: **Workspaces · Chats · Review · More**.

- **Workspaces** — projects and their workspaces with live status, chips, and
  PR state; drill into a workspace detail screen.
- **Workspace detail** — a segmented panel control carrying the desktop's panel
  names (Chat, Changes, Checks, Files, Terminal, Summary, Tasks, Timeline).
  Panels are the same concepts, laid out vertically.
- **Chats** — every live chat across workspaces, sorted by activity, so
  "who needs me" is one tap from launch.
- **Review** — changes awaiting review, failing checks, and open PRs.
- **More** — daemons, background tasks, skills, settings, history.

The daemon switcher lives in the navigation bar of every root tab, mirroring the
desktop `ClientSwitcher` placement above the nav.

## Phasing

Each phase is its own implementation plan and its own PR.

### P0 — Foundation

`ArchcarKit` transport (framing, handshake, dual sockets, reconnect, backoff),
the request/response/event layer for the workspace surface, `DaemonSession`,
Keychain storage, daemon list, QR + manual pairing, the desktop QR card, the
theme generator, app shell with tab bar, and the Workspaces tab rendering live
status from `ListWorkspaces` + `GetInventorySnapshot` + events.

Done when: a phone paired by QR shows the same workspace list and status dots
as the desktop, updating live as sessions start and finish.

### P1 — Drive agents

Thread list, chat timeline from `GetChatProjection` (markdown, tool calls,
inline diffs, plan cards), composer with attachments, `QueueChatInput` plus
queue reorder and removal, `InterruptTurn`, plan mode, model/effort/fast-mode/
permission-mode controls, and **provider interaction approvals** from
`ProviderInteractionRequested` — the blocked-agent case is the main reason a
phone is worth building.

Done when: an agent that stops to ask permission can be unblocked from the
phone, and a new turn can be started and watched streaming.

### P2 — Review

`GetWorkspaceChanges` list with scope switching, per-file diff viewer,
checks, todos and tasks, summaries and intel (`draft_workspace_summary`,
session contributions), PR strip with status and merge.

Done when: a change can be read, its checks inspected, and its PR merged from
the phone.

### P3 — Operations

Workspace creation for all four kinds (branch, prompt, GitHub, Linear),
archive and restore, background tasks including extra agents, processes and
scripts, settings, and history.

Done when: a workspace can be created, driven, and archived without touching a
desktop.

### P4 — Terminal and files

Session screen rendering backed by SwiftTerm with raw input
(`ArchcarInputKind::RawTerminal`), `ResizeSession` driven by the on-screen
geometry, workspace file browse, and file read/write.

Done when: a terminal session is usable on a phone keyboard and a file can be
edited and saved.

### P5 — Notifications and distribution

Daemon-side notifier plus APNs, TestFlight signing in CI.

`archcar` subscribes to its own event bus and pushes on
`ProviderInteractionRequested`, `TurnCompleted`, terminal
`BackgroundTaskUpdated` states, and `SessionError`. Core today has no HTTP
client, no async runtime, and no TLS stack, and APNs requires HTTP/2.
Rather than pull in `reqwest` + `tokio`, the notifier shells out to
`curl --http2` — the same shape as the existing `gh` shell-outs — and signs the
ES256 JWT with the `p256` crate. Device tokens live in a new SQLite table,
registered through a new RPC and cleared on APNs 410 responses.

This adds a second trust surface: the daemon gains outbound internet access and
holds an APNs signing key. The key path is configuration, never committed, and
the notifier is off unless a device has registered.

Needs from the user: Apple team ID, APNs key ID, and the `.p8` key file.
Until those exist, P5 ships local notifications only (alerts while the app is
foreground or briefly backgrounded), which is the honest fallback.

Done when: an agent blocking on permission raises a phone notification with the
app closed, and tapping it opens that chat.

## Testing and verification

Per phase, and named explicitly in every completion report:

- `swift test` on `ArchcarKit`, including the live-daemon round-trip suite that
  boots a real `archcar` over TCP in a temp root.
- `cargo test` for any Rust touched (P0 desktop pairing touches none; P5 does).
- `pnpm test` in `desktop/` plus a built-CSS byte diff when the QR card or
  styling changes.
- XCUITest smoke on the iOS simulator with screenshots for the phase's surface.
- CLI smoke where a phase changes daemon behaviour.

Anything that cannot be verified here — physical device install, TestFlight
distribution, real APNs delivery — is reported as unverified rather than
claimed.

## Risks

- **Projection payload size.** `GetChatProjection` was built for a desktop on
  loopback. Over a phone link it may be slow for long chats. Mitigation: measure
  in P1 with the chat perf bench approach and, if needed, add a range-limited
  projection request to core rather than truncating client-side.
- **Two sockets per daemon.** The server spawns a thread per connection; a phone
  reconnecting aggressively could accumulate threads if cleanup lags.
  P0 verifies that a killed phone connection drops its subscriber.
- **Parity drift.** Every desktop feature now has a second surface. The repo's
  existing rule — do not land user-visible behaviour in one surface only — must
  extend to iOS, or the phone rots. The spec's position: core keeps owning
  semantics, and the phone consumes the same projections, so drift shows up as
  a missing view rather than a different answer.
- **Terminal on a phone.** A VT100 screen on a 6" display is genuinely awkward.
  P4 treats read-and-occasional-input as the target, not full terminal work.
