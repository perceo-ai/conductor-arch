# Archductor terminal experience — investigation notes

Date: 2026-08-20
Status: investigation only. No design approved, no code.

## 1. What the reference actually is

`tcode` / "terminal-code" is [`zenbu-labs/terminal-code`](https://github.com/zenbu-labs/terminal-code),
invoked as `tode`. It is **not** a reimplementation of VS Code as a TUI. It is:

```
tode  =  terminal-browser (headless browser painted into the terminal)
       + code-server      (VS Code running in that browser)
```

Consequences worth copying or rejecting deliberately:

- Rendering is **pixels**, not cells. It requires the **kitty graphics
  protocol** (kitty, Ghostty, WezTerm, recent Konsole). Terminals without it
  are unsupported.
- Windows needs WSL plus a compatible terminal; there is no native Windows
  build.
- Keyboard is the hard part, not layout: `tode --shortcut-setup` exists purely
  to arbitrate conflicts between terminal-emulator chords and app chords.
- Mouse support comes free because the browser gets real mouse events.
- The upside is total fidelity: one UI codebase, zero feature drift, the whole
  editor works on day one.

So the honest framing of the user request is: *"give Archductor a first-class
full-screen terminal surface with the fidelity of the desktop app."* There are
several ways to get there and the tcode way is only one of them.

## 2. Archductor as it stands today

### Client topology

The daemon owns everything. All UIs are peers, not layers.

```
                    ┌──────────────────────────────┐
                    │  archcar daemon (Rust)       │
                    │  SQLite, PTYs, sessions,     │
                    │  provider adapters, git, gh  │
                    └───────────┬──────────────────┘
                       line-delimited JSON over
                       unix socket / TCP+token
        ┌───────────────┬───────┴────────┬──────────────────┐
        │               │                │                  │
  Electron+Solid   archductor CLI    MCP server       (nothing here yet)
  desktop/         crates/cli        crates/core/mcp_server.rs
```

- Protocol: single-line JSON envelopes, `payload.type` = snake_case enum
  variant. Schema of record: `crates/core/src/archcar/protocol.rs`; TS mirror at
  `desktop/src/bridge/protocol.ts` (889 lines).
- `subscribe` upgrades a connection to an `ArchcarEvent` stream: session
  lifecycle, chat queue updates, provider interactions, background tasks,
  `inventory_changed`.
- `get_inventory_snapshot` is the one-shot startup sync; everything else
  refreshes narrowly off events.
- Remote is already solved: `ARCHDUCTOR_ARCHCAR_REMOTE` + token, or the saved
  profile at `$XDG_STATE_HOME/archductor/remote.json`, shared by CLI and
  desktop. **A TUI client inherits server-hosted Archductor for free.**

This is the single most important finding: **a terminal surface is a fourth
client of an existing, complete, transport-agnostic API.** It does not need new
backend architecture.

### What the desktop surface actually contains

Shell (`desktop/src/App.tsx`, `Sidebar.tsx`, `pages/`):

| Region | Contents |
|---|---|
| Left rail | projects → workspaces, status dots, agent-count / task / PR chips |
| Center | chat tab strip, chat timeline, pending-ask card, composer |
| Right inspector | Tasks, Summary, Files, Changes, Checks, Context, Review, PR |
| Bottom dock | terminal tabs + processes, draggable vertical split |
| Overlays | command palette, shortcuts help, dialogs, toasts, setup modal, context menu |

Also: ~50 global shortcut actions already enumerated in
`App.tsx:GLOBAL_SHORTCUT_ACTIONS`, with user overrides via
`lib/shortcuts.ts`. That set is effectively a ready-made TUI keymap spec.

Terminal rendering today is **xterm.js** in `pages/TerminalPanel.tsx`: it
renders `get_session_screen` output and forwards keystrokes as
`send_input kind=raw_terminal`, resize as `resize_session`. Note the daemon
already models a *screen*, so a TUI would consume the same thing — but see the
open problem below.

### Existing CLI

`crates/cli/src/main.rs` is one 6312-line file, ~30 top-level subcommands
(`repo`, `workspace`, `session`, `diff`, `pr`, `review`, `checks`, `history`,
`archcar`, `service`, `remote`, …). It is verb-oriented and non-interactive.
Two known constraints:

- Under a remote profile, ~19 direct-store commands (`repo`, `workspace`,
  `status`, …) refuse, because they read the local SQLite directly rather than
  going through the daemon. Only `archductor archcar <cmd>` is remote-safe.
- CLI session support covers Shell / Codex / Claude; the desktop also launches
  Cursor.

Any TUI must be an **archcar-RPC client only**, never a direct-store client, or
it inherits that remote hole on day one.

### Prior art inside the repo

`crates/dev-runner` already depends on `crossterm` 0.29 and does raw-mode key
handling. Small, but it proves the toolchain and the workspace's appetite for
terminal code.

No `ratatui` anywhere. No TUI crate. Greenfield.

## 3. The real design forks

### Fork A — how do we render?

1. **Native TUI (ratatui + crossterm)** — new `crates/tui`, an RPC client
   drawing cells. Works in every terminal, over plain SSH, in tmux. Costs a
   second implementation of every surface, and creates exactly the parity
   hazard `claude/CLAUDE.md` legislates against ("do not land a user-visible
   change in only one surface").
2. **tcode-style pixel embed** — run the existing Electron/Solid UI headless
   and paint it via the kitty graphics protocol. Zero parity drift, full
   fidelity. Requires a kitty-graphics terminal, a headless Chromium on the
   client machine, and it fails over plain SSH to a dumb terminal — which is a
   large slice of the reason anyone wants this.
3. **Hybrid** — native TUI shell (rail, chat, inspector, palette) with pixel
   escape hatches only where cells genuinely lose information (image
   attachments, rendered diffs). Highest ceiling, most moving parts.

### Fork B — what is the scope of the terminal surface?

1. **Full control plane** — everything the desktop does: projects, workspaces,
   chat, inspector, diff review, PR flow, settings.
2. **Agent cockpit** — workspace list + chat + terminal + diff. Review/PR/
   settings stay in the desktop or CLI.
3. **Session attach** — `archductor session attach <workspace>`: a single
   full-screen chat/PTY view, no shell chrome. Smallest thing that would feel
   "managed".

### Fork C — where does it live?

1. New crate `crates/tui`, new binary, invoked as `archductor tui` (or a bare
   `archductor` with no args).
2. Inside `crates/cli`, which is already 6312 lines in one file and would need
   splitting first regardless.

### Fork D — who is the user, and where are they?

Local terminal next to the desktop app? Or SSH'd into a server-hosted archcar
with no display at all? These pull in opposite directions on Fork A: the SSH
case rules out the tcode approach outright.

## 4. Open problems to resolve before any design is real

1. **PTY fidelity inside a TUI.** The daemon's terminal model is "not a full
   terminal emulator" (`progress.md` Known Gaps). Painting a Codex/Claude TUI
   *inside* our TUI is emulator-in-emulator: alternate screen, CSI cursor
   moves, mouse reporting, and resize all have to survive two hops. The desktop
   punts this to xterm.js. A native TUI has no equivalent free lunch — it needs
   a vt100 parser crate (`vt100`/`termwiz`) and a real answer on nested mouse
   and alt-screen.
2. **Keybinding collisions.** ~50 actions vs. the terminal emulator vs. tmux vs.
   the nested agent TUI that wants the same chords. tcode shipped a whole
   `--shortcut-setup` wizard for this. Whatever we build needs a story, and it
   should reuse `lib/shortcuts.ts`'s action names so the keymap is one concept
   across surfaces.
3. **Parity enforcement.** `claude/CLAUDE.md`: user-visible core behavior must
   not land in only one surface. A third rendering surface makes that rule
   three times as expensive. Either the design keeps projection/state logic in
   `crates/core` so the TUI is thin, or scope must be explicitly and durably
   narrower than the desktop (Fork B2/B3) so "parity" is a defined subset, not
   an ever-growing debt.
4. **State/reducer duplication.** `desktop/src/store/` holds real logic
   (reducers, chat phases, panel widths, fuzzy search, diff parsing, markdown).
   A Rust TUI reimplements all of it unless the shared parts move into
   `crates/core` first.

## 5. Sources

- [zenbu-labs/terminal-code](https://github.com/zenbu-labs/terminal-code)
- [croft — VS Code-style TUI editor](https://terminaltrove.com/croft/)
- [OpenCode TUI docs](https://opencode.ai/docs/tui/)
- [VS Code TUI feature request (microsoft/vscode#228410)](https://github.com/microsoft/vscode/issues/228410)
