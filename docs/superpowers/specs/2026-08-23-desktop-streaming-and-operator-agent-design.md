# Desktop Streaming and Operator Agent Design

Date: 2026-08-23
Status: Approved design, not yet implemented
Spec 3 of 3. Depends on spec 1 (`modular-layout`) for the viewer panel.
Independent of spec 2 (`extension-manifests`).

## Problem

A client connected to a remote archcar daemon can read code, read diffs, read
logs, and start agents — but cannot see anything the work produces. The web app
under development, the Electron build under test, a GUI that crashed on launch:
all invisible. Work happens blind, and the only evidence that a change worked is
an agent asserting that it did.

## What was decided

The target is the **real host desktop**, streamed, with the agent able to
control it. Not a browser automation surface, not a virtual display, not a port
proxy. Whole-screen by default, with the ability to scope the stream — and the
agent's control — to a single monitor or a single window.

This is a deliberate choice with a real cost, recorded here so it is not
relitigated: whoever holds the archcar token can move the user's mouse. The
mitigations in *Security* are requirements of the design, not options.

Sequencing is equally deliberate. Phase 1 builds capture, streaming, and
**human** input. Phase 2 attaches an agent to the input channel that already
exists. Building the risky infrastructure with a human validating it turn by
turn is a far better way to shake out latency, coordinate mapping, and
permission problems than debugging them through an agent.

## Goals

**Phase 1 — see and drive**

- Enumerate capture targets: whole desktop, each monitor, each window.
- Stream the selected target to any connected client, local or remote.
- Let the viewing human move the mouse and type into that target.
- Work on macOS and Linux/X11. Linux/Wayland partial and labelled as such.

**Phase 2 — operator agent**

- A dedicated agent session, separate from the coding session, with computer-use
  tools over the same input channel.
- Its own provider and model, chosen independently of the coding agent.
- Reports findings back as text into the workspace timeline.

## Non-goals

- Virtual displays. Explicitly rejected; the target is the real desktop.
- Audio.
- Multi-user simultaneous control. One controller at a time.
- Recording to a file. Frames are ephemeral; screenshots persist as attachments.
- Giving the coding agent computer-use tools directly. See *Why a separate
  agent*.

## Platform reality

These are constraints, not preferences, and they shape what can be promised.

| Platform | Capture | Input | Status |
|---|---|---|---|
| macOS | ScreenCaptureKit; per-window supported | `CGEvent` post | Both need TCC grants (Screen Recording, Accessibility), user-granted, no headless path. Electron can hold both. |
| Linux/X11 | XShm or XComposite for per-window | XTEST | Straightforward. Fully supported. |
| Linux/Wayland | PipeWire via the ScreenCast portal | `libei` / RemoteDesktop portal | Compositor-dependent. Ships as **partial** with an explicit unsupported message where the portal is missing. |
| Windows | — | — | Out of scope, consistent with the project's Linux-first, macOS-second posture. |

Two consequences worth stating plainly:

**X11 input is global.** XTEST injects at the server, not at a window. Scoping
input to a window is therefore *advisory* on X11 — the design raises and focuses
the target window before injecting and clamps coordinates to its bounds, but a
window that loses focus mid-sequence can receive clicks meant for it elsewhere.
This is a real limitation of the platform and is documented in the UI, not
papered over.

**macOS permissions cannot be granted in CI.** Automated coverage on macOS is
limited to what runs without TCC. The macOS path is verified manually against
the checklist; this is called out in *Testing* rather than left implied.

## Architecture

```
crates/core/src/desktop/
  mod.rs          target enumeration, session lifecycle, grant state
  capture.rs      Capture trait + frame pump
  input.rs        Input trait + coordinate mapping + clamping
  encode.rs       frame diffing, JPEG/WebP encode, rate control
  backend/
    macos.rs      ScreenCaptureKit + CGEvent
    x11.rs        XShm + XTEST
    wayland.rs    PipeWire portal + libei (partial)
    unsupported.rs
```

Two traits, one per backend:

```rust
pub trait Capture: Send {
    fn targets(&self) -> Result<Vec<CaptureTarget>>;
    fn start(&mut self, target: &TargetId, opts: CaptureOpts) -> Result<()>;
    fn next_frame(&mut self, timeout: Duration) -> Result<Option<Frame>>;
    fn stop(&mut self);
}

pub trait Input: Send {
    fn move_to(&mut self, target: &TargetId, x: i32, y: i32) -> Result<()>;
    fn button(&mut self, b: Button, down: bool) -> Result<()>;
    fn scroll(&mut self, dx: i32, dy: i32) -> Result<()>;
    fn key(&mut self, key: Key, down: bool) -> Result<()>;
    fn type_text(&mut self, text: &str) -> Result<()>;
}
```

`CaptureTarget` carries `{ id, kind: Desktop|Monitor|Window, title, app, bounds,
scale }`. Window ids are platform handles and are revalidated before every
capture start, because windows close.

### Streaming

Frames go over the existing archcar connection rather than a new port. A second
listener would need its own auth, its own firewall story, and its own remote
configuration, and would break the property that one token and one address is
all a remote client needs.

`transport.rs` today is a `DuplexStream` trait over Unix sockets and TCP
carrying line-delimited JSON. It gains a binary frame type: a small header
(`stream_id`, `seq`, `len`, `flags`) followed by `len` bytes of payload,
distinguishable from a JSON line by its first byte. This is a real change to
the transport that both the Rust client (`archcar/client.rs`) and the desktop
bridge (`desktop/src/bridge/client.ts`) must handle, and it is the single
highest-risk item in the spec — every existing RPC rides this transport.

Codec choice: **JPEG or WebP still frames with dirty-rectangle diffing and
adaptive rate control**, not WebRTC. WebRTC would give better latency and
bandwidth but requires signalling, ICE, and a media stack — a large dependency
surface for the first version. Frame streaming reuses the transport that
already works and is honest about being a v1. If interaction latency proves
unacceptable in practice, WebRTC is the documented upgrade, and the viewer's
interface does not change.

Rate control: target 10 fps idle, up to 30 fps while input is active, backing
off on send-queue depth. Full keyframe on start, on target change, and every N
seconds; dirty rectangles in between.

### Input path

`send_input` carries coordinates **normalised to the target's bounds** (0.0–1.0),
not absolute screen pixels. The daemon maps them to absolute coordinates using
the live target bounds. This means a client rendering the stream at any size,
on any DPI, sends correct input without knowing the host's geometry — and it
means a client cannot address a pixel outside the target, because the
representation cannot express one.

On window-scoped targets the daemon raises and focuses the window before the
first event of a sequence, and rejects input if the target no longer exists.

## Security

Requirements, not options.

- **Input grant is per-session and defaults off.** Viewing never implies
  controlling. A client must explicitly request control and receive a grant.
- **Grants expire.** Default 15 minutes idle, renewed by activity, revoked on
  disconnect.
- **One controller at a time.** A second requester is refused with who holds it.
- **Global kill switch.** A hotkey (default `Ctrl+Alt+Shift+Esc`) and a tray item
  on the daemon host revoke every grant, stop every stream, and require manual
  re-enable. It is handled on the host, outside the renderer, so a wedged UI
  cannot block it.
- **Persistent visible indicator** on the daemon host whenever a stream is
  active or a grant is held, showing which target and which client.
- **Audit trail.** Every grant, revocation, and target change is a timeline
  event. Agent-issued input is logged as session events at a summarised
  granularity — per action, not per mouse-move — so a review can reconstruct
  what an agent did.
- **Streaming is off by default** and must be enabled in Settings on the host
  before any client can enumerate targets.
- **Window scoping is the privacy mechanism.** There is no way to exclude a
  region from a whole-desktop capture of a real screen; scoping to the window
  under test is what keeps a password manager out of frame, and the UI should
  say so at the point of choosing.

## Protocol

Phase 1:

- `desktop_status` → `{ enabled, backend, capabilities: {capture, input}, warnings: [] }`
- `list_capture_targets` → `{ targets: CaptureTarget[] }`
- `start_desktop_stream { target_id, max_fps?, quality? }` → `{ stream_id }`
- `stop_desktop_stream { stream_id }` → `ok`
- `request_input_grant { stream_id }` → `{ grant_id, expires_at }` or refusal
- `release_input_grant { grant_id }` → `ok`
- `send_input { grant_id, events: InputEvent[] }` → `ok`
- `capture_screenshot { target_id }` → `{ attachment }` — one-shot, no stream

Events: `desktop_stream_started`, `desktop_stream_stopped`,
`desktop_input_grant_changed`, `desktop_target_lost`.

`InputEvent` is a batch-friendly enum — `Move{x,y}`, `Button{button,down}`,
`Scroll{dx,dy}`, `Key{key,down}`, `Text{s}` — so a drag is one round trip
rather than forty.

Phase 2 adds no new transport surface. The operator agent's tools map onto the
same RPCs.

## Desktop UI

A `desktop` panel registered in spec 1's panel registry, allowed in centre and
bottom. The **Watch** built-in preset gives it the centre.

Contents: a target picker (desktop / monitor / window, grouped by application),
the stream canvas, a control toggle showing grant state and expiry, a
screenshot button, and a stats line (fps, latency, bytes/s) that is the
difference between "this feels slow" and a diagnosable report.

When control is held, the canvas captures pointer and keyboard, shows a visible
border, and displays how to release. Keyboard capture must not swallow the
app's own global shortcuts — release is always reachable.

Where the backend is partial (Wayland without a portal), the panel says exactly
what is unavailable and why, rather than presenting a dead canvas.

## Phase 2: the operator agent

### Why a separate agent

The coding agent's context is the wrong place for screenshots. A screenshot is
on the order of a thousand tokens; an agent checking a button ten times has
spent more context on images than on the code it is editing. Separating them
also allows a model chosen for vision to do the looking while the coding agent
stays on a model chosen for code — and it makes the result reviewable, because
the operator's report lands in the timeline as a normal session artifact rather
than as tool output buried mid-conversation.

### Shape

The operator is a normal managed session with a restricted toolset, started
alongside the coding session in the same workspace. The multi-agent plumbing
already exists: `StartBackgroundTask.extra_agents` runs several managed agents
in one workspace, each with its own session and prompt, all linked to the same
task. The operator reuses that path rather than inventing a parallel one.

Tools, exposed through the existing MCP server in
`crates/core/src/mcp_server.rs` so any managed agent can be granted them:

- `desktop_targets` — list targets
- `desktop_screenshot { target_id }` — returns an image
- `desktop_click { target_id, x, y, button }` — normalised coordinates
- `desktop_type { text }`
- `desktop_key { key }`
- `desktop_scroll { dx, dy }`
- `desktop_wait { ms }`

Every one requires a live input grant held by the operator's session. The tools
are hidden entirely when streaming is disabled or no grant exists, so an agent
cannot discover them and try.

### Handoff

The coding agent requests verification through a task on the workspace
("verify the login flow renders and submits"). The operator picks it up, drives
the desktop, and writes a text report — what it saw, what it did, what failed —
back to the thread, attaching screenshots via `chat_attachments.rs` at
decision points rather than every step. The coding agent reads the report. It
never sees raw frames.

### Grant policy for agents

An agent-held grant is stricter than a human's: shorter default expiry (5
minutes), scoped to a specific target chosen by the human when the operator
starts, and revoked automatically when the operator session ends. Escalating
from a window-scoped to a desktop-scoped target requires human approval; an
agent cannot widen its own scope.

## Error handling

- **Backend unavailable** — `desktop_status` reports it with a specific reason
  (TCC not granted, no portal, no `DISPLAY`). The panel renders that reason and
  a remediation, not an error code.
- **TCC denied on macOS** — detected on first capture attempt; the panel links
  to the correct System Settings pane, because the grant cannot be requested
  programmatically once denied.
- **Target disappears** — stream stops with `desktop_target_lost`; the panel
  returns to the picker. Any agent grant on that target is revoked.
- **Client too slow** — frames are dropped, never queued unboundedly. The stats
  line shows the drop rate.
- **Transport backpressure** — the frame pump yields to RPC traffic. A slow
  stream must never delay a normal request; this is the failure mode that would
  make the whole app feel broken.
- **Grant expiry mid-drag** — buttons are released before revocation, so nothing
  is left stuck down.
- **Kill switch** — stops everything immediately; in-flight input is discarded,
  not drained.

## Testing

Rust unit:

- Coordinate mapping: normalised to absolute across scales, DPI, and multi-monitor
  origins; out-of-range values clamp rather than escape the target.
- Grant lifecycle: default off, single holder, expiry, revoke on disconnect,
  agent grants narrower than human grants, no self-escalation.
- Frame diffing and rate control: dirty rects correct, keyframe cadence, drop
  under backpressure.
- Transport framing: binary frames and JSON lines interleave and decode
  correctly; an old client sees a clean protocol error rather than corruption.

Linux integration (CI, under Xvfb): enumerate targets, capture a known window,
assert pixel content; inject a click on a test window and assert it received it;
confirm window-scoped clamping.

macOS: manual, added to `docs/manual-testing-checklist.md` — TCC grants cannot
be automated. Stated as a coverage gap rather than presented as tested.

Two-host: the Docker Linux daemon plus macOS client recipe, which is where
client-versus-daemon path and geometry assumptions surface. Verify enumeration,
streaming, and input from a macOS client against a Linux daemon.

Desktop: Vitest over the frame decoder and the normalised-coordinate math;
Playwright smoke of the panel against a daemon with a fake backend that emits
synthetic frames, so the UI is testable without a real display.

CLI smoke: `archductor desktop status`, `desktop targets`,
`desktop screenshot --target <id> --out /tmp/x.png`. The CLI does not stream —
there is nothing for it to render — but status, enumeration, and one-shot
screenshot keep it in parity for everything that is not inherently visual.

## Increments

1. **Enumeration + one-shot screenshot.** `desktop_status`,
   `list_capture_targets`, `capture_screenshot`, X11 and macOS backends, CLI.
   No streaming, no input. Proves capture and permissions on both platforms
   with a fraction of the machinery.
2. **Transport binary frames.** Framing, client handling, backpressure, and its
   tests, landed alone — because every existing RPC rides this transport.
3. **Streaming + viewer panel.** Encode, rate control, the panel, target
   switching. View-only.
4. **Human input.** Grants, kill switch, indicator, audit, input backends.
5. **Wayland backend.** Partial, clearly labelled.
6. **Operator agent.** MCP tools, restricted toolset, agent grant policy,
   report-back handoff.

Steps 1 through 4 are Phase 1 and deliver the stated goal on their own: remote
clients stop working blind. Step 6 is Phase 2.

## Risks

- **Transport change is the big one.** Adding binary framing to the transport
  every RPC depends on can break everything at once. Land it alone, with tests,
  and verify the two-host path before building on it.
- **Latency may disappoint.** Frame streaming over a JSON-oriented transport
  is a pragmatic v1, not a good remote-desktop protocol. Over a WAN it may be
  poor enough that WebRTC becomes necessary. The viewer interface is designed
  so that swap does not change the UI.
- **macOS coverage is manual.** TCC cannot be granted in CI, so regressions on
  macOS will be found by a person or not at all.
- **Wayland may not work** on the user's compositor. Shipping it partial is
  honest; shipping it silently broken is not.
- **Window scoping is advisory on X11.** Stated in the UI. A user who needs
  hard isolation does not have it on X11, and should not be told otherwise.
- **Native backends mean new dependencies** — ScreenCaptureKit and CGEvent
  bindings, X11 libraries, PipeWire, libei — with platform-conditional
  compilation and packaging implications across the AppImage, Flatpak, AUR,
  and Homebrew targets in `packaging/`. Budget for the packaging work; it is
  not free.
- **The operator agent is only as good as its model's vision.** If it
  misreads a screen it will report confidently wrong results, which is worse
  than no verification. Its report format should distinguish what it observed
  from what it concluded, and screenshots should be attached so a human can
  check the observation.
