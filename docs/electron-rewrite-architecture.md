# Electron Rewrite Architecture

## Context

The `gtk-app` crate works but its state/refresh layer is hard to read in Rust:
`Rc<RefCell<HashMap<usize, Rc<dyn Fn(...)>>>>` callback registries, manual borrow
discipline, thread-local wake registries. The *design* underneath is good — a
scoped refresh event taxonomy (`refresh.rs::RefreshEvent`) that already avoids
full-page rerenders. The pain is Rust ergonomics, not the model.

Goal: replace **only the UI** with an Electron app whose reactivity is
fine-grained and easy to reason about, while keeping the exact look and the
proven Rust backend.

Decisions (confirmed with owner):

1. **Scope: UI-only.** Keep `core`, `archcar`, `cli` Rust unchanged. Rewrite
   `gtk-app` in Electron/TypeScript.
2. **Reactivity: Solid.js.** Fine-grained signals, no VDOM diffing. Maps 1:1 onto
   the existing `RefreshEvent` scoping — a signal per scope, updates touch only the
   exact DOM nodes that changed. This is the "full control of rerenders" the owner
   wants.
3. **Bridge: archcar Unix socket.** Electron main speaks the existing JSON-RPC
   protocol (`core/src/archcar/protocol.rs`). Extend the protocol with read/query
   RPCs (backed by `core` stores that archcar already holds) as each page needs
   them — no second transport.

## Current backend (kept as-is)

- **core** — git worktrees, PTY, SQLite (`storage.rs`), provider event parsing,
  GitHub/Linear. SQLite at `~/.local/share/archductor/archductor.db`.
- **archcar** — long-lived daemon over Unix socket
  (`~/.local/state/archductor/archcar.sock`). Owns session lifecycle, durable
  input queue, provider event streaming. Protocol: `ArchcarRequest` /
  `ArchcarResponse` / `ArchcarEvent` envelopes (`RpcEnvelope<T>` = `{id, payload}`),
  newline-delimited JSON. `Subscribe` opens the event stream.
- **cli** — automation, unchanged.

Today `gtk-app` calls `core` **in-process** for git/diff/workspace/settings/DB
reads and only uses archcar for sessions. Electron is a separate process, so those
reads must move onto the socket. Plan: grow `ArchcarRequest` with query variants
(e.g. `ListWorkspaces`, `ListRepositories`, `GetWorkspaceDiff`, `GetSettings`,
`ListTodos`, `GetReview`) that call the same `core` stores. Each is small and
additive; add per page, not up front.

## Process topology

```text
Electron main (Node)                        Rust
┌───────────────────────────┐   Unix socket ┌──────────────┐
│ archcar client (1 conn)   │◄─────JSON-RPC─►│ archcar      │──► core ──► SQLite
│  - request/response map    │   + event feed │  (daemon)    │        └► git/PTY
│  - Subscribe event stream  │               └──────────────┘
│ spawns archcar if absent   │
└─────────────┬─────────────┘
   contextBridge IPC (typed)
┌─────────────▼─────────────┐
│ Renderer (Solid)           │
│  reactive store  ◄── events│
│  components ── requests ──► │
└───────────────────────────┘
```

- Main holds ONE archcar connection. Renderer never touches the socket directly
  (security: `contextIsolation` on, `nodeIntegration` off). Preload exposes a
  typed `window.archductor` API: `request(req)` → Promise, `onEvent(cb)` stream.
- Main spawns archcar if the socket is missing (mirrors
  `gtk-app/src/archcar_async.rs`).

## Reactivity model (the thought-through part)

The `RefreshEvent` enum is effectively a dependency graph. We reproduce it as
**keyed Solid stores** so a change to thread 7's messages updates only thread 7's
transcript nodes — nothing else re-runs.

Store shape (renderer, `src/store/`):

- `nav` — signals for `selectedWorkspace`, `activePage`, `activeWorkspaceTab`,
  `selectedChatThread`, `rightPanelTab`. Mirrors `state.rs::AppStateSnapshot`
  navigation fields. Page stack reads `activePage`; only the mounted page runs.
- `workspaces` — `createStore` keyed by name. Row components read
  `store.workspaces[name].status` etc.; a status change reconciles just that key.
- `chat` — nested keyed store: `chat[threadId].messages`, `.queue`, `.session`,
  `.phase`. Appending a message uses `produce`/path-set so only the appended row
  renders (`<For>` keyed by message id → no re-render of existing rows).
- `providerEvents` — keyed by `identity_key`; streaming deltas merge in place
  (mirrors `provider_events.rs` upsert-by-identity), so a streaming token updates
  one text node.
- `review`, `todos`, `diff`, `terminal` — keyed by workspace.

Event → store mapping (main event feed → `applyEvent` reducer):

| ArchcarEvent / derived      | Store mutation (targeted)                    |
|-----------------------------|----------------------------------------------|
| `SessionMessagesUpdated`    | reload `chat[thread].messages` (keyed `<For>`)|
| `ChatQueueUpdated`          | set `chat[thread].queue`                      |
| `SessionReady`/`TurnCompleted` | set `chat[thread].session`/`.phase`        |
| provider event delta        | merge `providerEvents[identity_key]`          |
| `SessionError`              | set `chat[thread].phase = Failed`             |

Rules that keep rerenders minimal (enforced by convention + lint):
- Components read the **narrowest** signal/path they need. No "read whole store".
- Lists use keyed `<For>` (id key) so item identity is stable.
- Derived values via `createMemo`; no recompute unless inputs change.
- The reducer mutates by path (`setChat(threadId, "messages", ...)`), never
  replaces parent objects wholesale.
- A dev overlay counts updates per store key (port of
  `refresh.rs::RefreshMetrics`) to catch accidental broad updates.

Optimistic UI phases (`WorkspaceUiPhase`, `ChatUiPhase` in `state.rs`) live as
`phase` fields in the keyed stores; the reducer clears them when the durable event
arrives (mirrors `resolve_pending_chat_target`).

## UI parity

- **Theme**: translate `theme.rs::APP_CSS` (GTK CSS) → `src/styles/theme.css`.
  `@define-color lc-x #hex` → `:root { --lc-x: #hex }`; GTK widget selectors → web
  class selectors. Keep every color/size/font/spacing value. Default dark; keep the
  `lc-theme-*`, `lc-accent-*`, `lc-density-*` class toggles.
- **Layout**: reproduce the widget tree from the UI map — collapsible 320px
  sidebar (`OverlaySplitView`), 52px column headers, page `Stack`, workspace
  command center with `Paned` split + 8 tabs, chat surface + composer, kanban
  dashboard. Custom window controls on non-mac (frameless `BrowserWindow`).
- **Terminal**: `xterm.js` fed by archcar `GetSessionScreen` / screen-updated
  events; input via `SendInput` raw-terminal kind.
- **Fonts**: bundle Mona Sans + Commit Mono (see `font_assets.rs`).

## Phases

0. Scaffold `desktop/` (Vite + Solid + Electron + TS).
1. Reactive store core + archcar bridge (main + preload + TS client) + theme CSS.
2. App shell: window chrome, sidebar, page stack, projects/workspace list.
3. Dashboard (kanban) + navigation.
4. Workspace command center shell + tab strip + right panel.
5. Chat surface + composer + queue + provider-event rendering + streaming.
6. Changes/diff, Review, Terminal (xterm), Checks, Todos, Processes, Checkpoints.
7. Settings, command palette, keyboard shortcuts, toasts, setup wizard.
8. Packaging (electron-builder) parity with AppImage/deb/rpm; retire gtk-app.

Each phase: extend archcar RPC only as needed, keep CLI+GTK behavior claims honest
(per CLAUDE.md — don't land user-visible change in one surface silently).

## Verification

- Store: vitest unit tests per reducer — assert an event mutates only its key
  (port the `refresh.rs` "updates X only" tests). Update-counter overlay in dev.
- Bridge: integration test against a running archcar (spawn daemon, `Subscribe`,
  send input, assert events).
- Visual: side-by-side screenshots vs GTK for each page; Playwright snapshot tests
  on the renderer.
- Smoke: `pnpm dev` launches, connects to archcar, lists real workspaces, opens a
  chat, streams a turn.
