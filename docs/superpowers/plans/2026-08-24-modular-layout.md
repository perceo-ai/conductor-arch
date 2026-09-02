# Modular Layout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the fixed Electron workspace shell with a fast, accessible four-region workbench whose panels can move, hide, restore, resize, and persist in named presets while the immutable Code preset preserves today's UI.

**Architecture:** Pure TypeScript layout operations and a runtime panel registry own all layout semantics. Solid stores/components render that model and provide keyboard, menu, resize, and pointer-drag controls. Named presets persist through a small SQLite-backed archcar API; active preset and region geometry remain device-local.

**Tech Stack:** Solid.js 1.9, TypeScript 5.7, Vitest 2, Electron 33, Rust, rusqlite, serde, clap, archcar JSON RPC, CSS pointer interactions.

**Spec:** `docs/superpowers/specs/2026-08-23-modular-layout-design.md`

## Global Constraints

- Work only on modular layout; extension manifests and desktop streaming remain out of scope.
- `Sidebar` remains fixed application chrome outside the workbench.
- Regions are exactly `left | center | right` over a full-width `bottom` row; no nested splits, floating panels, tear-outs, or duplicate panel instances.
- Code is immutable, always present, default, and visually preserves `chat` centre plus `pr`, inspector tabs, and terminal dock on right.
- Editing any built-in forks it to a user preset before applying the edit; failed remote saves never roll back the in-memory layout.
- `PanelKind` is `tab | strip | dock`: PR is the only strip; terminal is the only dock, preserving the current utility drawer while remaining movable.
- Centre must contain at least one tab or dock; strips do not satisfy the invariant.
- Unknown panel ids are dropped and logged; corrupt layouts fall back to Code and notify once.
- Pointer drag starts only after 4px, Escape cancels, invalid regions never advertise a target, and reduced-motion users get no drag animation.
- Every pointer-only operation also has a keyboard/menu path; icon buttons have accessible names and visible focus.
- Built-in presets are Code, Wide, Review, Watch in that order. User presets sort after built-ins by case-insensitive name.
- Preset JSON cap is 256 KiB for `layout_json` and 64 KiB for `hidden_json`; built-in ids `code`, `wide`, `review`, `watch` cannot be saved or deleted.
- Default project preset is stored in repository-committed `[customization.view].default_layout_preset`; active preset, sizes, and collapsed regions are renderer-local.
- Written tests, CLI smoke, and real Electron desktop smoke are required before completion.

---

### Task 1: Pure layout domain, registry, built-ins, and device preferences

**Files:**
- Create: `desktop/src/lib/layout.ts`
- Create: `desktop/src/lib/layout.test.ts`
- Create: `desktop/src/lib/panelRegistry.ts`
- Create: `desktop/src/lib/panelRegistry.test.ts`
- Create: `desktop/src/lib/layoutPresets.ts`
- Create: `desktop/src/lib/layoutPresets.test.ts`
- Modify: `desktop/src/lib/panelWidths.ts`
- Modify: `desktop/src/lib/panelWidths.test.ts`
- Modify: `desktop/src/store/prefs.ts`
- Modify: `desktop/src/store/prefs.test.ts`
- Modify: `desktop/src/pages/WorkspaceFiles.tsx`
- Commit: approved spec and this plan with Task 1

**Interfaces:**
- Produces `Region`, `PanelId`, `PanelKind`, `Stack`, `Layout`, `DropTarget`, `movePanel`, `hidePanel`, `showPanel`, `activatePanel`, `resizeRegion`, `collapseRegion`, `sanitizeLayout`, `dropTarget`, and `visiblePanelIds` from `layout.ts`.
- Produces `PanelProps { workspace: string; region: Region }`, `PanelDescriptor`, `registerPanel`, `unregisterPanel`, `panelDescriptor`, `registeredPanels`, and `workspacePanels` from `panelRegistry.ts`.
- Produces `LayoutPreset`, `BUILTIN_PRESETS`, `builtinPreset`, `mergePresets`, `forkBuiltinPreset`, and `presetAfterEdit` from `layoutPresets.ts`.
- Extends `Prefs` with `activePresetId`, `regionSizes`, and `collapsedRegions`, plus setters that persist atomically in the existing v1 preference object.

- [x] **Step 1: Write failing layout behavior tests**

  Add literal fixtures for a centre `chat`, right `pr` strip + `changes` tab + `terminal` dock layout. Tests must prove: moving removes the old occurrence; wrong-kind insertion is impossible; disallowed regions return the original object; moving the last centre tab/dock is rejected; hide repairs active index; show uses the descriptor default; activation un-hides and un-collapses; resize clamps left to `220..420`, right to `260..440`, and bottom to `160..560`; sanitization drops unknown/duplicate/wrong-kind ids; `dropTarget` returns literal region/index values at before/between/after tab midpoints and returns `null` for disallowed regions.

- [x] **Step 2: Run RED tests**

  Run `cd desktop && pnpm vitest run src/lib/layout.test.ts src/lib/panelRegistry.test.ts src/lib/layoutPresets.test.ts src/lib/panelWidths.test.ts src/store/prefs.test.ts` and confirm failures are missing modules/exports and missing preference fields.

- [x] **Step 3: Implement registry and pure layout operations**

  Use immutable cloned layouts. Route ids to `panels`, `strips`, or `docks` from descriptor kind. Normalize every active index to `0` for empty tab lists or clamp to `panels.length - 1`. `WorkspaceFiles` must default its `openFile` callback to `openFileInCenter(workspace, path)` so its registered descriptor needs only `PanelProps`.

- [x] **Step 4: Implement exact built-in layouts and edit forking**

  Code: centre `chat`; right strip `pr`, tabs `summary/files/changes/checks` active `changes`, dock `terminal`; left/bottom empty; hidden `todos/checkpoints/processes/timeline/context`. Wide: files left, chat centre, PR + summary/changes/checks right, terminal bottom. Review: files left, changes centre, PR + checks/summary/chat right, terminal bottom. Watch: terminal centre, summary/checks right, chat bottom. `forkBuiltinPreset(code)` returns a non-builtin id beginning `custom-`, name `Code (edited)`, and a deep-cloned layout.

- [x] **Step 5: Extend size rules and migrate preferences**

  Add `LEFT_MIN=220`, `LEFT_MAX=420`, `BOTTOM_MIN=160`, `BOTTOM_MAX=560`, `REGION_DEFAULT_SIZES={left:260,center:0,right:300,bottom:280}`, and `clampRegionSize`. On preference load, copy a finite `rightPanel.width` into `regionSizes.right`, copy finite `terminalDock.height` into `regionSizes.bottom`, then remove only `rightPanel.width`; retain `terminalDock.height` because Code's terminal dock still consumes it. Keep `sidebarCollapsed` unchanged because Sidebar is not a workbench region.

- [x] **Step 6: Run GREEN tests and full renderer baseline**

  Run the focused command from Step 2, then `cd desktop && pnpm test && pnpm typecheck`.

- [x] **Step 7: Commit**

  Commit message: `feat(desktop): add modular layout domain`

### Task 2: Render the immutable Code layout with zero visible regression

**Files:**
- Create: `desktop/src/store/layout.ts`
- Create: `desktop/src/store/layout.test.ts`
- Create: `desktop/src/components/PanelRegion.tsx`
- Create: `desktop/src/components/WorkspaceWorkbench.tsx`
- Modify: `desktop/src/store/index.ts`
- Modify: `desktop/src/pages/CommandCenter.tsx`
- Modify: `desktop/src/pages/TerminalDock.tsx`
- Modify: `desktop/src/styles/base.css`

**Interfaces:**
- Consumes Task 1 domain and descriptors.
- Produces `layoutStore` signals/methods: `layout`, `activePreset`, `hiddenPanels`, `focusedRegion`, `setFocusedRegion`, `applyLayout`, `mutate`, `resetToCode`.
- `PanelRegion` renders strips, a keyboard-operable tablist, one active tab body, and docks in this order.
- `WorkspaceWorkbench` renders left/centre/right grid row plus bottom row and owns region data attributes used by later DnD.

- [ ] **Step 1: Write failing store tests**

  Prove initial state is a deep clone of Code, preference region sizes/collapse flags overlay the preset, `applyLayout` sanitizes unknown ids, and changing returned fixtures cannot mutate `BUILTIN_PRESETS`.

- [ ] **Step 2: Run RED test**

  Run `cd desktop && pnpm vitest run src/store/layout.test.ts`; expected failure is missing `layoutStore`.

- [ ] **Step 3: Implement layout store and generic region renderer**

  Render descriptor components with `{ workspace, region }`. Tab buttons use `role="tab"`, `aria-selected`, `aria-controls`, roving `tabIndex`, ArrowLeft/ArrowRight/Home/End navigation, and stable `data-panel-id`. Strips and docks get `data-panel-kind`; dock gets `data-panel-id` for focus/reveal.

- [ ] **Step 4: Refactor CommandCenter around WorkspaceWorkbench**

  Keep `TopBar` inside centre above its region. Remove hardcoded right switch, width state, and right tab constants. Preserve existing CSS classes as compatibility classes inside new region markup so the built Code layout keeps spacing, tab counts, Review prompt button, PR bar, and collapsed TerminalDock. `TerminalDock` accepts optional `region`; it uses today's persisted drawer height in right and fills available space, expanded, in centre/bottom/left.

- [ ] **Step 5: Add one final cascade block**

  Append one labelled `/* Modular workbench */` block after existing workspace rules. Use CSS grid columns `auto minmax(360px,1fr) auto`, a conditional bottom row, `contain: layout paint` on regions, and `min-width/min-height:0` on every flex/grid child. Add `@media (prefers-reduced-motion: reduce)` overrides. Do not edit earlier duplicate `.ws-center`/`.ws-right-panel` blocks.

- [ ] **Step 6: Verify visual-equivalence boundary**

  Run `cd desktop && pnpm vitest run src/store/layout.test.ts && pnpm typecheck && pnpm build`. Inspect built CSS to confirm the modular block occurs after legacy `.ws-center` and `.ws-right-panel` rules: `rg -n "Modular workbench|ws-right-panel|ws-center" dist/assets/*.css`.

- [ ] **Step 7: Commit**

  Commit message: `refactor(desktop): render workspace from layout`

### Task 3: Central reveal action, live panel shortcuts, and command-palette safety net

**Files:**
- Modify: `desktop/src/store/layout.ts`
- Modify: `desktop/src/store/layout.test.ts`
- Modify: `desktop/src/store/actions.ts`
- Modify: `desktop/src/App.tsx`
- Modify: `desktop/src/components/CommandPalette.tsx`
- Modify: `desktop/src/pages/openFileBridge.ts`
- Modify: `desktop/src/pages/WorkspaceTabs.tsx`

**Interfaces:**
- Produces `actions.revealPanel(panelId, { activate?: boolean })`, `layoutStore.cyclePanel(delta)`, and `layoutStore.focusPanel(panelId)`.
- Replaces every direct `nav.setRightPanelTab` call and terminal/right-panel visibility event with layout actions; navigation history no longer stores inspector tab state.

- [ ] **Step 1: Write failing reveal/cycle tests**

  Prove reveal restores a hidden panel to its default region, opens a collapsed region, activates tabs but not strips/docks, and schedules focus on `[data-panel-id='<id>']`. Prove cycle order is live visible tabs in region order `left,center,right,bottom`, skips hidden/special panels, and wraps both directions.

- [ ] **Step 2: Run RED test**

  Run `cd desktop && pnpm vitest run src/store/layout.test.ts`; expected failures are missing reveal/cycle methods.

- [ ] **Step 3: Implement actions and convert call sites**

  `show-changes`, `show-uncommitted`, `show-files`, `show-checks`, and `show-summary` select workspace then reveal matching panel. `toggle-terminal` reveals terminal before dispatching the existing expand event. `toggle-right-panel` calls `collapseRegion('right', ...)`. File/commit opens reveal `chat` before invoking registered bridge callbacks. Review prompt reveal uses `changes`.

- [ ] **Step 4: Generate palette panel commands from registry**

  Replace `PRODUCT_RIGHT_PANEL_TABS` with all workspace descriptors. Labels are exactly `Show: <title>`, hint is current workspace title, group is `Panels`, and each calls `actions.revealPanel`. Keep files searchable and route them through the updated bridge.

- [ ] **Step 5: Remove retired right-panel navigation state**

  Delete `rightPanelTab` from `desktop/src/store/nav.ts`, its history snapshot, `lib/rightPanelTabs.ts`, and its tests only after `rg -n "rightPanelTab|PRODUCT_RIGHT_PANEL_TABS" desktop/src` returns no production references.

- [ ] **Step 6: Run tests**

  Run `cd desktop && pnpm test && pnpm typecheck && pnpm build`.

- [ ] **Step 7: Commit**

  Commit message: `feat(desktop): reveal panels from every command path`

### Task 4: Hide, restore, collapse, resize, and menu-based arrangement

**Files:**
- Create: `desktop/src/components/LayoutControls.tsx`
- Create: `desktop/src/components/LayoutControls.test.tsx`
- Modify: `desktop/src/components/PanelRegion.tsx`
- Modify: `desktop/src/components/WorkspaceWorkbench.tsx`
- Modify: `desktop/src/store/layout.ts`
- Modify: `desktop/src/store/layout.test.ts`
- Modify: `desktop/src/pages/CommandCenter.tsx`
- Modify: `desktop/src/styles/base.css`

**Interfaces:**
- Produces visible Layout button in workspace TopBar, tab close controls, region collapse controls, and context-menu commands `Move to Left/Center/Right/Bottom` + `Hide <title>`.
- Every edit passes through `layoutStore.mutate`, which forks a built-in before mutation and persists size/collapse state locally.

- [ ] **Step 1: Write failing interaction/store tests**

  Test immutable built-in edit forks once, later edits stay on same custom working preset, hiding active tab selects nearest remaining tab, centre's final content cannot hide/collapse, size/collapse changes persist to prefs, and menu button exposes every hidden panel by accessible label.

- [ ] **Step 2: Run RED tests**

  Run `cd desktop && pnpm vitest run src/store/layout.test.ts src/components/LayoutControls.test.tsx`; confirm missing controls/fork behavior.

- [ ] **Step 3: Implement edit controls**

  Use semantic buttons. Close buttons appear on hover/focus but retain a 28px target. Right-click tab menu offers only descriptor-allowed regions. Layout menu sections: current layout name, hidden panels, visible regions, Reset to Code. An `aria-live="polite"` status reports moves/hides/restores without toast spam.

- [ ] **Step 4: Add region resize and responsive collapse**

  Use `ResizeHandle` on left/right/bottom with live prefs updates. If viewport width cannot satisfy Sidebar + left + centre + right minimums, collapse left first, then right, without mutating saved collapse choices; restore automatically when space returns. Bottom never exceeds 60vh.

- [ ] **Step 5: Verify keyboard and narrow-window behavior**

  Run component/store tests, `pnpm typecheck`, `pnpm build`; launch dev Electron and keyboard-test Tab/Arrow/Home/End, hide/restore, region move through context menu, 900px minimum window, and 200% zoom. Record result in task report.

- [ ] **Step 6: Commit**

  Commit message: `feat(desktop): add accessible panel controls`

### Task 5: Pointer drag-and-drop with insertion feedback and snappy motion

**Files:**
- Create: `desktop/src/components/PanelDnd.tsx`
- Create: `desktop/src/components/PanelDnd.test.tsx`
- Modify: `desktop/src/components/PanelRegion.tsx`
- Modify: `desktop/src/components/WorkspaceWorkbench.tsx`
- Modify: `desktop/src/lib/layout.ts`
- Modify: `desktop/src/lib/layout.test.ts`
- Modify: `desktop/src/styles/base.css`

**Interfaces:**
- `PanelDnd` exposes context callbacks to register tab-strip rectangles, begin/cancel pointer sessions, and report current `{ panelId, target }`.
- Consumes pure `dropTarget` and commits exactly one `layoutStore.movePanel` on pointer release.

- [ ] **Step 1: Write failing threshold, cancel, restriction, and commit tests**

  Using real pointer-like events in jsdom, prove movement under 4px remains a click, 4px starts drag, Escape cancels without mutation, pointerup on disallowed region does nothing, pointerup on allowed strip commits the literal caret index, and cleanup removes window listeners after drop/unmount.

- [ ] **Step 2: Run RED tests**

  Run `cd desktop && pnpm vitest run src/lib/layout.test.ts src/components/PanelDnd.test.tsx` and confirm failures arise from missing DnD behavior.

- [ ] **Step 3: Implement pointer session**

  Use pointer capture from the tab button, one `requestAnimationFrame` for geometry reads per frame, cached region/strip rectangles, and transform-only drag ghost movement. Never mutate layout during pointermove. Escape/pointercancel/unmount share one cleanup path.

- [ ] **Step 4: Implement feedback and polish**

  Allowed regions show an inset accent outline; hovered region gets a soft tint; tab insertion caret is 2px; drag ghost uses current tab text/icon, `pointer-events:none`, and max 180px width. CSS transitions are 90ms opacity/transform only and disabled for reduced motion. Cursor changes from grab to grabbing only after threshold.

- [ ] **Step 5: Verify**

  Run `cd desktop && pnpm test && pnpm typecheck && pnpm build`. In Electron drag Changes right-to-bottom, Files right-to-left, PR strip right-to-left, and terminal right-to-bottom; confirm click activation still works, Escape cancels, composer focus survives moving Chat, and no pointer listeners remain after repeated drags.

- [ ] **Step 6: Commit**

  Commit message: `feat(desktop): add snappy panel drag and drop`

### Task 6: Daemon preset persistence, project default, protocol, and CLI parity

**Files:**
- Create: `crates/core/src/layout_presets.rs`
- Modify: `crates/core/src/lib.rs`
- Modify: `crates/core/src/storage.rs`
- Modify: `crates/core/src/settings.rs`
- Modify: `crates/core/src/archcar/protocol.rs`
- Modify: `crates/core/src/archcar/server.rs`
- Modify: `crates/cli/src/main.rs`
- Modify: `desktop/src/bridge/protocol.ts`

**Interfaces:**
- Produces Rust `LayoutPreset { id, name, builtin, layout_json, hidden_json, created_at, updated_at }` and `WorkspaceStore::{list_layout_presets,save_layout_preset,delete_layout_preset}`.
- Adds `ViewSettings.default_layout_preset: Option<String>` and raw-TOML-preserving `set_default_layout_preset(repo_path, preset_id)`.
- Adds RPC requests/responses exactly named in spec and matching TypeScript unions.
- Adds top-level CLI `layout presets [--repository NAME]`, `layout show ID`, `layout delete ID`, `layout set-default ID --repository NAME`, plus archcar `layout-presets`.

- [ ] **Step 1: Write failing Rust storage/settings tests**

  Test built-ins return first in Code/Wide/Review/Watch order; user rows case-insensitive by name; valid save/upsert round-trip; invalid JSON, empty id/name, values exceeding the 256 KiB layout or 64 KiB hidden caps, and built-in ids reject; delete unknown is idempotent but built-in delete rejects; `default_layout_preset` shared/local merge and TOML round-trip; raw setter preserves unrelated keys and writes repository shared layer.

- [ ] **Step 2: Run RED tests**

  Run `cargo test -p archductor-core --lib layout_presets` and `cargo test -p archductor-core --lib default_layout_preset`; expected failures are missing module/field/functions.

- [ ] **Step 3: Implement table and store**

  Add table from spec to `migrate_workspace_db`. Store timestamps as existing text epoch strings. Built-in JSON uses layout version 1 and includes `docks`; built-ins are returned but never inserted. Parse both JSON strings with `serde_json::from_str::<Value>` before writes and enforce byte caps before DB work.

- [ ] **Step 4: Implement settings field and raw setter**

  Thread field through `ViewSettings`, `RawViewSettings`, merge, conversion, serialization, defaults, validation, and collection-independent settings tests. Raw setter creates/navigates `customization.view` tables and preserves unrelated TOML values.

- [ ] **Step 5: Add RPCs and end-to-end dispatch test**

  Add request summaries that omit layout JSON bodies. Server handlers use `WorkspaceStore::open_app(db_path)` and `RepositoryStore` for project default. Response summaries include preset count/id only. Read-only classifier includes list only. Add one dispatch test covering list, save, list, default set, delete.

- [ ] **Step 6: Add CLI and TS protocol parity**

  `layout presets --repository demo` marks `*` beside matching default; built-ins include `[built-in]`; `show` prints `layout_json`; delete/set-default print normal response summaries. Update clap parse tests and response printer tests with literal output.

- [ ] **Step 7: Verify Rust and CLI**

  Run `cargo fmt --all --check`, `cargo test -p archductor-core --lib layout_presets`, `cargo test -p archductor-core --lib default_layout_preset`, `cargo test -p archductor-core --lib archcar::protocol`, and `cargo test -p archductor`.

- [ ] **Step 8: Commit**

  Commit message: `feat(core): persist modular layout presets`

### Task 7: Preset loading, switching, saving, deletion, and project-default UI

**Files:**
- Create: `desktop/src/store/layoutPresets.ts`
- Create: `desktop/src/store/layoutPresets.test.ts`
- Modify: `desktop/src/store/layout.ts`
- Modify: `desktop/src/store/index.ts`
- Modify: `desktop/src/components/LayoutControls.tsx`
- Modify: `desktop/src/components/LayoutControls.test.tsx`
- Modify: `desktop/src/pages/CommandCenter.tsx`
- Modify: `desktop/src/store/prefs.ts`
- Modify: `desktop/src/styles/base.css`

**Interfaces:**
- Produces `layoutPresetsStore` with `load`, `select`, `saveWorkingCopy`, `rename`, `delete`, and `setProjectDefault`.
- `layoutStore.mutate` applies edit synchronously, forks built-ins once, debounces remote save 250ms, and keeps the local result on failure while showing one actionable toast.

- [ ] **Step 1: Write failing store and control tests**

  With complete protocol-shaped fake responses, prove load merges/sanitizes, invalid JSON falls back Code with one toast, unknown ids are dropped with one log, active preset restores from prefs, absent active preset falls back project default then Code, built-in edit creates exactly one save after 250ms, failed save retains layout, delete cannot target built-in, selecting presets changes layout immediately, and set-default sends repository name + preset id.

- [ ] **Step 2: Run RED tests**

  Run `cd desktop && pnpm vitest run src/store/layoutPresets.test.ts src/store/layout.test.ts src/components/LayoutControls.test.tsx`.

- [ ] **Step 3: Implement store lifecycle**

  Load once after inventory connection and reload when daemon endpoint changes through normal app startup. Parse `layout_json`/`hidden_json`, overlay device sizes/collapse, save active id to prefs, and cancel pending debounce on switch/delete/unmount. User preset ids use `custom-${crypto.randomUUID()}` with a timestamp/random fallback for unavailable crypto.

- [ ] **Step 4: Finish Layout controls**

  Topbar trigger shows current name. Menu offers built-ins first, then user presets; Save as new, Rename, Delete for user only, Set as project default, and Reset Code. Built-ins show a lock marker/title. Confirm destructive user-preset delete with existing dialog system. Keep menu keyboard navigation and focus return from existing context-menu behavior.

- [ ] **Step 5: Verify frontend integration**

  Run `cd desktop && pnpm test && pnpm typecheck && pnpm build`.

- [ ] **Step 6: Commit**

  Commit message: `feat(desktop): sync layout presets across clients`

### Task 8: Documentation, full verification, CLI smoke, and Electron smoke

**Files:**
- Modify: `progress.md`
- Modify: `docs/manual-testing-checklist.md`
- Modify: `README.md`

**Interfaces:**
- Documents exact product behavior and evidence without claiming extension manifests or streaming are implemented.

- [ ] **Step 1: Update user and verification docs**

  Add modular layout workflow: switch presets, edit/fork built-ins, drag/menu movement, hide/restore, collapse/resize, project default, CLI lifecycle, and immutable Code recovery. Add manual checks for all five previously unreachable panels and narrow/wide/reduced-motion/keyboard behavior.

- [ ] **Step 2: Run full written verification**

  Run `cargo fmt --all --check`; `cargo clippy -p archductor-core -p archductor -p archcar --all-targets -- -D warnings`; `cargo test -p archductor-core --lib`; `cargo test -p archductor`; then `cd desktop && pnpm test && pnpm typecheck && pnpm build`. If the four documented `/var` versus `/private/var` and raw terminal macOS tests still fail unchanged, record exact names as pre-existing; any new failure blocks completion.

- [ ] **Step 3: Run isolated live CLI/archcar smoke**

  Use `mktemp -d` for `XDG_DATA_HOME`, `XDG_STATE_HOME`, `XDG_CONFIG_HOME`, and a temporary git repository. Start built `archcar`, add repository, then run: `archductor layout presets --repository demo`; save a custom preset through an RPC envelope; `archductor layout show custom-smoke`; `archductor layout set-default custom-smoke --repository demo`; re-list and confirm `*`; delete; confirm absent. Stop only the spawned daemon.

- [ ] **Step 4: Run real Electron smoke**

  Launch Electron against isolated daemon. Verify Code opening geometry; Changes right-to-bottom drag survives reload; Wide and Review switch instantly; built-in drag forks to `Code (edited)` while Code remains selectable; PR moves but remains a strip; terminal moves and fills bottom; hidden Todos/Checkpoints/Processes/Timeline/Context each open; command palette restores hidden Changes; keyboard menus move panel; Escape cancels drag; 900px window auto-collapses side region; reduced-motion disables motion. Capture screenshot/log paths under `.context/modular-layout-smoke/`.

- [ ] **Step 5: Check branch scope and commit docs**

  Run `git status --short`, `git diff --check`, and `git diff origin/main... --stat`. Confirm sibling extension/streaming specs remain uncommitted and no unrelated user files changed. Commit message: `docs: document modular workspace layouts`
