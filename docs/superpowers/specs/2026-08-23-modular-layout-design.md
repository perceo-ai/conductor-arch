# Modular Layout Design

Date: 2026-08-23
Status: Approved design, not yet implemented
Spec 1 of 3. Specs 2 (`extension-manifests`) and 3
(`desktop-streaming-and-operator-agent`) are siblings; spec 3 depends on this
one.

## Problem

The desktop shell is fixed. `CommandCenter.tsx` hardcodes two columns:

```
Sidebar (app chrome, in App.tsx)  |  ws-center            |  ws-right-panel
                                     TopBar                  WorkspacePrBar
                                     ChatSurface             tab strip (4 tabs)
                                                             active tab body
                                                             TerminalDock
```

The right column's tabs come from a four-entry constant in
`lib/rightPanelTabs.ts` (summary, files, changes, checks); the active one lives
in `nav.rightPanelTab()`. `TerminalDock` is stacked at the bottom of that same
right column, not under the centre. `WorkspacePrBar` sits at its top, which
means collapsing the right panel today also hides PR status. Column widths drag
and persist through `lib/persistedWidth.ts`, but nothing else about the
arrangement can change: a panel cannot move, cannot be hidden, and cannot appear
twice. There is no left region and no bottom region.

That is fine for one workflow and wrong for the several this app actually
serves. Reviewing a diff, watching a long agent run, and writing code want
different arrangements of the same panels, and today all three get the layout
that suits writing code.

A second, quieter problem: six panel components are written, exported, and
referenced nowhere — `TodosPanel`, `CheckpointsPanel`, `ProcessesPanel`,
`TimelinePanel` (`WorkspaceTabs.tsx`), `ContextPanel` (`WorkspaceIntel.tsx`),
and `ChangesTab` (`WorkspaceChanges.tsx`). `progress.md` claims Todos, Timeline,
and Checkpoints live under other tabs. They do not; they are unreachable. A
panel registry gives them a home for almost no marginal cost.

## Goals

- Any panel can live in any of four regions, stacked with other panels as tabs.
- Panels can be hidden and restored.
- Arrangements are saved as named presets the user switches between.
- A project can declare which preset it opens with.
- The layout system is capable of dynamic panel registration, so a future
  extension-contributed panel needs no structural change.

## Non-goals

- Arbitrary nested splits, floating windows, or tear-out panels. The layout
  model is versioned so this can be added later; it is not built now.
- Extension-contributed panels. The registry accepts dynamic registration;
  nothing registers through it this round. See spec 2.
- Multiple instances of the same panel. Every panel is a singleton for now;
  the instance model below leaves room to relax this.
- Per-workspace layouts. Variation is per-activity, not per-repository.

## Architecture

Three pieces, deliberately separated so the hard part is testable without a
browser.

### 1. Panel registry (`desktop/src/lib/panelRegistry.ts`)

A map from panel id to a descriptor. Built-in panels register at module load.

Implementation clarification (2026-08-24): the approved requirements that the
Code preset remain an exact replica and that `TerminalDock` remain movable
cannot both be represented by only `tab` and `strip`. A normal tab would hide
the terminal whenever Changes is active, while a strip renders above the tab
bar. The model therefore has a third `dock` kind. A dock renders after the
active tab body and may satisfy the centre region's non-empty invariant. This
keeps the current right-column utility drawer exact in Code, fills the bottom
region in Wide, and fills the centre in Watch. `PanelProps` also includes the
current region so the terminal can retain its compact drawer behavior on the
right and fill a dedicated centre/bottom region.

```ts
export type PanelKind = "tab" | "strip" | "dock";

export interface PanelDescriptor {
  id: PanelId;                       // stable, persisted in layouts
  title: string;
  icon: IconName;
  kind: PanelKind;                   // "strip" renders above the tab strip
  component: Component<PanelProps>;
  regions: Region[];                 // where it may be dropped
  defaultRegion: Region;
  minWidth?: number;                 // honoured when in left/right
  minHeight?: number;                // honoured when in bottom
  requiresWorkspace: boolean;        // hidden on Dashboard/History/Settings
}
```

`PanelProps` carries `{ workspace: string; region: Region }`. Region is layout
context rather than injected application state; panels still read application
state from their existing stores. This keeps the registry from becoming a
second dependency-injection system.

**Three panel kinds.** A `tab` panel is one entry in a region's tab strip — the
normal case. A `strip` panel renders *above* a region's tab strip, always
visible while that region is, and never competes for tab selection. `pr` is the
only strip panel. A `dock` renders after the active tab body; `terminal` is the
only dock panel. Both special kinds remain movable and hideable.

Initial panel set. `Visible in Code` marks whether the Code preset shows it —
the six dead components are registered but hidden, which makes them reachable
from the palette without changing the default view:

| Panel id | Kind | Component | Default region | Visible in Code |
|---|---|---|---|---|
| `chat` | tab | `ChatSurface` (default export) | center | yes |
| `pr` | strip | `WorkspacePrBar` (default export) | right | yes |
| `summary` | tab | `WorkspaceIntel.SummaryPanel` | right | yes |
| `files` | tab | `WorkspaceFiles` (default export) | right | yes |
| `changes` | tab | `WorkspaceChanges.ChangesTab` | right | yes |
| `checks` | tab | `WorkspaceTabs.ChecksPanel` | right | yes |
| `terminal` | dock | `TerminalDock` (default export) | right | yes |
| `todos` | tab | `WorkspaceTabs.TodosPanel` | right | no |
| `checkpoints` | tab | `WorkspaceTabs.CheckpointsPanel` | right | no |
| `processes` | tab | `WorkspaceTabs.ProcessesPanel` | right | no |
| `timeline` | tab | `WorkspaceTabs.TimelinePanel` | right | no |
| `context` | tab | `WorkspaceIntel.ContextPanel` | right | no |

Notes on that table:

- `changes` uses `ChangesTab`, not the `ChangesRows` currently rendered inline.
  `ChangesTab` is the self-contained version (it owns path/scope state and
  renders `DiffView`), which is what a movable panel needs. `ChangesRows` stays
  exported because `ChangesTab` uses it.
- There is no `editor` panel. `ChatSurface` owns file and commit tabs
  internally via `openFileBridge.ts`; opening a file targets chat wherever chat
  is.
- `terminal` defaults to `right`, not `bottom`, because that is where it lives
  today and the Code preset must be an exact replica. The bottom region exists
  and is empty in Code; the Wide preset uses it.

`Sidebar` stays outside the layout system — it is navigation chrome, not a
panel, and making it movable costs the shell its fixed anchor.

### 2. Layout model (`desktop/src/lib/layout.ts`)

A pure module. No Solid primitives, no DOM — this is where the tests live.

```ts
export type Region = "left" | "center" | "bottom" | "right";

export interface Stack {
  panels: PanelId[];   // tab order (kind === "tab" only)
  strips: PanelId[];   // rendered above the tab strip, in order
  docks: PanelId[];    // rendered after the active tab body, in order
  active: number;      // index into panels
  size: number;        // px width (left/right) or height (bottom)
  collapsed: boolean;
}

export interface Layout {
  version: 1;
  regions: Record<Region, Stack>;
}
```

Region-keyed rather than a nested tree, on purpose. The four regions cover the
approved scope, and a flat model is far easier to reason about and to render.
The `version` field is the migration hook: a future free-workbench layout
becomes `version: 2` with a tree, and a `migrate(v1) -> v2` function that puts
each region's stack at the corresponding edge of the tree.

**Region topology.** `left`, `center`, and `right` are columns in a row;
`bottom` spans the full width beneath all three. This is the conventional IDE
shape and it is what the Wide preset wants. The Code preset simply leaves
`bottom` empty, which renders as no row at all.

```
┌─────────┬──────────────────────┬─────────┐
│  left   │       center         │  right  │
├─────────┴──────────────────────┴─────────┤
│                bottom                    │
└──────────────────────────────────────────┘
```

Operations, all pure `(Layout, args) => Layout`:

- `movePanel(layout, panelId, toRegion, toIndex)` — routes to `panels` or
  `strips` based on the descriptor's `kind`; `toIndex` indexes the target list
- `hidePanel(layout, panelId)` / `showPanel(layout, panelId, region?)`
- `activatePanel(layout, panelId)` — also un-hides and un-collapses; a no-op on
  selection for strip panels, which are always visible in their region
- `resizeRegion(layout, region, size)`
- `collapseRegion(layout, region, collapsed)`

Invariants enforced by the module, not by callers:

- `center` may never have both an empty `panels` list and an empty `docks`
  list. Moving its last tab/dock panel out is rejected; the operation returns
  the layout unchanged. Strips do not satisfy this — a centre holding only the
  PR strip is still empty.
- A panel appears in at most one list across all regions. `movePanel` removes
  before inserting.
- `active` is always a valid index into `panels`, or `panels` is empty.
- A panel may only land in a region its descriptor allows.
- A `tab` panel never enters `strips` and vice versa.
- Sizes are clamped using the existing `panelWidths.ts` rules, extended to
  cover the bottom region's height.

Anything the layout references but the registry doesn't know — a panel id from
an older build, or from a preset written by a future version — is dropped on
load and logged. Presets must survive a downgrade without wedging the app.

### 3. Presets

```ts
export interface LayoutPreset {
  id: string;
  name: string;
  builtin: boolean;
  layout: Layout;
  hidden: PanelId[];
}
```

Four built-ins ship:

- **Code** — an *exact replica* of today's shell, and the default. Centre holds
  `chat`; right holds the `pr` strip plus tabs `summary`, `files`, `changes`,
  `checks`, `terminal`, with `changes` active (matching `nav.rightPanelTab()`'s
  current default). Left and bottom are empty. The five dead panels are hidden.
  Upgrading changes nothing a user can see.
- **Wide** — the modernised arrangement: `files` left, `chat` centre, `pr` +
  `summary`/`changes`/`checks` right, `terminal` bottom full-width. Opt-in, so
  nobody's muscle memory moves without them choosing it.
- **Review** — `changes` centre, `files` left, `pr` + `checks`/`summary` right,
  `chat` right, `terminal` bottom. Diff gets the space; chat becomes the
  inspector.
- **Watch** — `terminal` centre, `summary`/`checks` right, `chat` bottom. For
  supervising a long background run. This is the preset spec 3's desktop viewer
  will occupy.

**Code is immutable and always present.** It is compiled in, cannot be deleted,
and cannot be edited in place. Rearranging while any built-in is active forks it
into a user preset ("Code (edited)") and switches to that — so the layout is
free to edit, and the known-good baseline always survives a stray drag. This is
the single guarantee that makes drag-and-drop safe to ship on by default.

### Storage split

Preset definitions live in the daemon. The active preset and region sizes live
on the device.

That split is not arbitrary. A preset is a named artifact you author once and
want on every client — the same reasoning that puts repository settings in
archcar. Region sizes are the opposite: a phone client and a 34-inch monitor
have genuinely different correct answers, and syncing them means one client
permanently corrupts the other's layout. `prefs.ts` already draws this line for
`pinnedWorkspaces` with the same argument ("two people pointed at the same
daemon should be able to pin differently"), so this follows an established
local precedent rather than inventing one.

Daemon side — new table:

```sql
CREATE TABLE layout_presets (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  layout_json  TEXT NOT NULL,
  hidden_json  TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);
```

Built-ins are not rows. They are compiled-in defaults merged into the list at
read time, so a schema change to a built-in preset ships with the binary and
does not require a migration.

Per-project default preset goes in `ViewSettings` in `crates/core/src/settings.rs`
as `default_layout_preset: Option<String>`, which puts it in the existing
shared/local settings layering for free.

Device side — extends `Prefs` in `desktop/src/store/prefs.ts`:

```ts
activePresetId: string;                          // default "code"
regionSizes: Record<Region, number>;             // px
collapsedRegions: Region[];
```

The existing `sidebarCollapsed` and the `persistedWidth` localStorage keys are
migrated into `regionSizes` on first load, then the old keys are removed.

## Protocol

Four new archcar requests, following the existing naming in
`crates/core/src/archcar/protocol.rs`:

- `list_layout_presets` → `{ presets: LayoutPreset[] }` (built-ins + rows)
- `save_layout_preset { preset }` → `{ preset }` (upsert; rejects builtin ids)
- `delete_layout_preset { id }` → `ok` (rejects builtin ids)
- `set_project_default_preset { repository, preset_id }` → `ok`

`layout_json` is stored and transported opaquely as a string. The daemon
validates that it parses as JSON and is under a size cap; it does not validate
panel ids, because the daemon has no business knowing the renderer's panel
vocabulary and would need a release-locked copy of it to check.

## Drag and drop

Implemented directly on pointer events in a new
`desktop/src/components/PanelDnd.tsx`. No drag-and-drop library: HTML5 DnD is
awkward in Electron and inconsistent across platforms, and the interaction
needed here is narrow enough that a library would cost more than it saves.

Behaviour:

- Drag starts on a tab after 4px of movement, so a click still activates.
- While dragging, each region shows a drop zone; the hovered region's tab strip
  shows an insertion caret at the computed index.
- Drop zones only appear for regions the dragged panel's descriptor allows.
- Dropping on the tab strip inserts at the caret index; dropping on a region
  body appends.
- Escape cancels.

The index computation is pure and lives in `layout.ts` as
`dropTarget(regions, pointer) -> { region, index } | null`, so it is unit
tested without a browser.

## Reveal, and what it replaces

Once a user can hide the Changes panel, any code that says "switch to the
Changes tab" is broken. This is the part of the work most likely to be
under-scoped, so it is called out explicitly.

A single action replaces every ad-hoc tab switch:

```ts
actions.revealPanel(panelId: PanelId, opts?: { activate?: boolean })
```

It un-hides the panel into its default region if hidden, un-collapses that
region, makes it the active tab, and focuses it. Call sites to convert:
`openFileBridge.ts`, the review-prompt flow in `WorkspaceTabs.tsx`, the
`show-changes` and `toggle-terminal` shortcuts in `App.tsx`, and the workspace
actions in `CommandPalette.tsx`.

The command palette gains one entry per registered panel ("Show: Changes"),
generated from the registry, which makes every panel reachable regardless of
layout. That is the safety net that makes hiding panels acceptable at all.

## CLI parity

Presets are daemon state, so the CLI must be able to see them —
`CLAUDE.md`'s rule that user-visible core behaviour does not land in one
surface applies. The CLI does not need to *arrange* layouts, since it has no
layout to arrange, but it needs read and lifecycle access:

- `archductor layout presets` — list, marking built-ins and the project default
- `archductor layout show <id>` — print the layout JSON
- `archductor layout delete <id>`
- `archductor layout set-default <id>` — writes `ViewSettings`

`archcar layout-presets` provides the same over the socket for smoke testing.

## Error handling

- **Unknown panel id in a stored layout** — dropped on load, logged once, the
  rest of the layout applies. Never a hard failure.
- **Corrupt layout JSON** — falls back to the Code built-in, toasts once.
- **Preset save fails** (daemon down, remote profile unreachable) — the layout
  stays applied in memory and the toast says it was not saved. Losing a drag to
  a network blip is worse than a stale preset.
- **Layout that cannot fit the viewport** — CSS min-widths shrink columns as
  they do today; `panelWidths.ts` clamping prevents drags from crossing the
  centre minimum. A window too narrow for the preset collapses side regions
  rather than squeezing chat below usable width.
- **Built-in preset edit** — prompts to fork; never silently mutates.

## Testing

Unit (Vitest, alongside the existing `desktop/src/lib/*.test.ts` suite):

- `layout.test.ts` — every operation, plus each invariant: centre never empties,
  no duplicate panel, active index always valid, region restrictions honoured,
  size clamping.
- `dropTarget` — caret index at strip boundaries, disallowed regions return
  null, empty-region append.
- `panelRegistry.test.ts` — unknown ids dropped; `requiresWorkspace` filtering.
- `presets.test.ts` — built-in merge order, fork-on-edit, migration of legacy
  `persistedWidth` keys into `regionSizes`.

Rust:

- `layout_presets` CRUD, builtin-id rejection, size cap, JSON validation.
- `ViewSettings` round-trip through the shared/local settings layering.

CLI smoke: `archductor layout presets`, `layout set-default`, then re-read to
confirm the project default persisted.

Electron smoke, using the Playwright recipe already used for desktop UI checks:
drag Changes from right to bottom, confirm it renders there, reload, confirm it
persisted, switch preset, confirm the arrangement changes, and run
`revealPanel` on a hidden panel to confirm it comes back.

## Increments

Delivered as a single pull request, but built and committed in this order so
each commit is independently revertable:

1. **Layout model + registry.** Pure modules and their tests. No rendering
   change at all.
2. **Render from layout.** The shell renders the Code layout instead of
   hardcoded JSX. Visually identical; this is the load-bearing step.
3. **Reveal + palette entries.** Convert every ad-hoc tab switch. Still no user
   rearrangement, so nothing can break yet.
4. **Hide/show + region collapse.** First user-visible change.
5. **Drag and drop.**
6. **Presets** — daemon table, RPCs, CLI, built-ins, fork-on-edit, project
   default.

Steps 1 through 3 are the ones worth doing carefully; 4 through 6 are additive
on top of a correct model.

## Risks

- **Panels written for a fixed width.** `ChangesRows` and the diff view assume
  the narrow right column. Moving them to centre will expose layout bugs. Each
  panel needs a pass at both narrow and wide, and that cost is per-panel, not
  per-system.
- **Step 2 is a large mechanical diff** across `CommandCenter.tsx` and the
  page files, with no behaviour change to show for it. It will be tempting to
  fold step 4 into it; doing so makes the regression surface much harder to
  reason about.
- **The workspace shell CSS is layered.** `.ws-right-panel` is redefined at
  `base.css:648`, `:687` (a media query), `:4011`, and `:4861`; `.ws-center` at
  `:610`, `:3694`, `:4863`. Import order and cascade position are load-bearing.
  New region CSS must be added as a distinct block and verified with a built-CSS
  byte diff, not by eyeballing the app — a rule that already has scar tissue
  behind it in this repo.
- **The dead panels may be broken.** `TodosPanel`, `CheckpointsPanel`,
  `ProcessesPanel`, `TimelinePanel`, and `ContextPanel` have not rendered in a
  while. They are registered hidden, so they cannot regress the default view,
  but each needs a manual open before this is called done — and any that are
  broken should be fixed or left unregistered, not shipped broken.
- **Keyboard navigation** — `next-panel`/`prev-panel` currently walk a fixed
  order. They must walk the live layout instead, or they will send focus to
  hidden panels.
- **Chat is special.** It is the primary surface today and the composer holds
  focus state. Moving chat into a bottom stack is legal under this model and
  will need testing that the composer, attachments, and scroll anchoring all
  survive a region change.
