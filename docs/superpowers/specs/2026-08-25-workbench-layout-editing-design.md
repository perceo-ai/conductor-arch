# Workbench layout editing

**Status:** design, approved in outline (model, panel kinds, edit mode)
**Date:** 2026-08-25

## Problem

Panels are hard to rearrange and it is hard to tell what is draggable or where a
drag will land. The presenting symptoms are affordance-level — an invisible grip
button, a 1px drop outline, a 2px insertion caret — but the cause is the model.

`src/lib/layout.ts` describes the workbench as four fixed slots:

```ts
export type Region = "left" | "center" | "bottom" | "right";
export interface Layout { version: 1; regions: Record<Region, Stack> }
```

Left, center, right and bottom are not arrangeable objects. They are hardcoded
names bound to fixed screen positions. Panels move *between* slots; the slots
themselves cannot move, split, be created, or be removed. "Move the left panel
to the right" is not a drag that fails — it is a state the type cannot express.

This also explains why the drop feedback is thin. With four fixed rectangles
there is nothing more specific to compute than "which rectangle is the pointer
in, and between which two tabs", which is exactly what `dropTarget` returns.

Improving the affordances without changing the model would make a constrained
system easier to see. The goal is a system worth seeing.

## Decisions

Settled before this document:

1. **Recursive split tree.** Any arrangement expressible: three columns, a right
   side split into two rows, a center split in half.
2. **Every panel is a tab.** `PanelKind` stops being structural and becomes a
   presentation hint. A leaf is a list of panels and an active index.
3. **Full layout mode.** Drag, split, resize, collapse, close and add-panel all
   happen inside an explicit mode. Normal mode is strictly "use the app".
4. **No dedicated grip button.** `.workbench-panel-grip` is deleted.
5. **No migration.** See *Versioning* below.

## Model

```ts
/** Opaque, stable for the life of a node. Generated on create, preserved
 *  across edits, serialized with the layout. Drop results name nodes by id
 *  rather than by path, so a concurrent edit cannot silently retarget a drop. */
export type NodeId = string;

export type LayoutNode = LayoutLeaf | LayoutSplit;

export interface LayoutLeaf {
  type: "leaf";
  id: NodeId;                 // stable across edits; drop targets refer to it
  panels: PanelId[];
  active: number;
  /** Presentation hint carried over from the retired PanelKind. */
  display: "tabs" | "compact";
  collapsed: boolean;
}

export interface LayoutSplit {
  type: "split";
  id: NodeId;
  direction: "row" | "column";
  /** Exactly two children. Three columns is a row whose child is a row. */
  children: [LayoutNode, LayoutNode];
  /** First child's share of the split, 0..1. The second gets the remainder. */
  ratio: number;
}

export interface Layout { version: 2; root: LayoutNode }
```

Two children per split rather than N. An N-ary split needs a size per child and
a rule for redistributing when one is removed; a binary split needs one ratio
and collapses to its surviving child. Three columns is `row(a, row(b, c))`,
which renders identically and has no degenerate states.

`display: "compact"` preserves what `strip` and `dock` looked like — a short
fixed-height leaf with no tab bar when it holds one panel. It is a rendering
choice, not a placement constraint: a compact leaf can be dragged, split and
stacked like any other. `panelDescriptor.kind` seeds the initial value; a leaf
holding more than one panel always renders as tabs.

`collapsed` on a leaf means the leaf renders at its header height only and its
parent split gives the remainder to its sibling. The stored `ratio` is left
untouched so expanding restores the previous proportion. A split whose children
are both collapsed is itself collapsed by the same rule, recursively. The
current model forbids collapsing `center`; the tree has no privileged node, so
the equivalent rule is that the last non-collapsed leaf cannot be collapsed —
there is always somewhere for content to be.

### Sizing

`ratio` replaces per-region pixel sizes. Ratios survive window resizing, which
the current pixel sizes do not, and they remove the special case where `center`
has `size: 0` because it takes the remainder.

Minimum sizes stay, expressed in pixels and enforced at render: a split clamps
its ratio so neither child falls below the largest minimum of the panels it
contains. `panelWidths.ts` keeps `LEFT_MIN` and friends as *panel* minimums
rather than region minimums, and `clampRegionSize` is replaced by
`clampSplitRatio(direction, ratio, availablePx, minPx)`.

### Device-local sizes are retired

`prefs.regionSizes` and `prefs.collapsedRegions` are device-local overrides keyed
by region name — `Record<Region, number>` and `Region[]`. They exist so one
machine's window width does not push its pane sizes onto another.

They do not survive the change and are removed. Keying them by `NodeId` instead
would be worse than useless: ids are regenerated whenever a preset is applied, so
the overrides would silently stop matching after any preset switch and leave
behind an unbounded pile of dead keys. Ratios are resolution-independent in a way
pixel widths are not, which is most of what the per-device override was
compensating for.

The cost is real and should be stated plainly: pane sizes become part of the
saved layout, so resizing a pane on one machine changes it on every machine
sharing that preset. `prefs.ts` keeps `activePresetId` and drops the other two,
along with the legacy `rightWidth`/`terminalHeight` migration that feeds them.

### What is deleted

- `Region`, `Record<Region, Stack>`, `Stack`, `REGION_DEFAULT_SIZES`,
  `clampRegionSize`.
- `PanelDescriptor.regions` — every panel already declares `allRegions`, so the
  constraint is vacuous today and has nothing to translate into.
- `PanelDescriptor.defaultRegion` — replaced by the panel's position in the
  default preset, which is where the information actually belongs.
- `.workbench-panel-grip` and its hover rules.

`LayoutPreset.hidden` stays as it is. It is already derived rather than
authoritative — the store recomputes it after every edit as "registered panels
not present in the layout" — and that derivation is indifferent to whether the
layout is four stacks or a tree. Closing a panel in edit mode removes it from
its leaf; it reappears in the add-panel list by the same derivation.

## Versioning

The preset feature is unreleased. `main` is at `v0.5.0`; every layout commit
lives on the unmerged `modular-archductor-plans` branch. `version: 1` layouts
therefore exist only on development machines, never in an installed copy.

`sanitizeLayout` accepts `version: 2` and returns the Code preset for anything
else, including `version: 1`. No migration path is written, and none is
maintained. The one visible consequence — a developer's saved custom layouts
reset once — is worth avoiding a translation layer for a shape that was never
shipped.

The daemon side is untouched: `layout_presets.layout_json` stays an opaque
string, so `crates/core/src/layout_presets.rs` needs no change beyond its
existing size validation.

## Edit mode

Entered from the Layout menu and by a keyboard shortcut; exited by `Escape` or
`Done`. The specific binding is assigned during planning, alongside the existing
`Cmd/Ctrl+Shift+N/D/P` workflow shortcuts in `src/lib/shortcuts.ts`, so it can be
checked against them for conflicts rather than guessed at here. While active:

- A thin persistent chrome appears: an "Editing layout" bar with `Done`,
  `Reset to <preset>`, and an add-panel control listing hidden panels.
- Every leaf gains a header that is itself the drag surface — the whole header,
  not a button inside it. This is what replaces the grip.
- Leaves show a close affordance and a collapse affordance.
- Split handles become visible and draggable.

Outside edit mode none of the above renders, and the layout is inert. Panels are
used, not moved.

**Edits are live, not transactional.** Each drag or resize applies immediately
and goes through the existing debounced save. `Escape` leaves the mode; it does
not roll back. A transactional mode would need a snapshot buffer and a rule for
what happens when a save fails mid-edit, and the existing per-preset save
already gives a cheap undo: `Reset to <preset>` restores the last saved state.

## Drop targeting

The tree is what makes the drop legible. Over any leaf, the pointer's position
within that leaf selects one of six intents:

| Pointer region | Intent |
|---|---|
| Over the tab bar | Insert into this leaf at a tab index |
| Centre zone | Append to this leaf as a tab |
| Left edge | Split, dragged panel to the left |
| Right edge | Split, dragged panel to the right |
| Top edge | Split, dragged panel above |
| Bottom edge | Split, dragged panel below |

Zone geometry, measured within the leaf's content box below its tab bar: the
centre zone is the middle 50% on both axes. Outside it, the edge is whichever of
the four the pointer is nearest as a *fraction* of that axis — comparing
`x / width` against `y / height` rather than raw pixels, so a wide short leaf
does not become all-left-and-right. Ties go to the horizontal edge. A leaf too
small to give the edge zones a usable depth (under 120px on an axis) offers only
the centre zone on that axis, so a narrow leaf cannot be split into two
unusably narrow ones.

Feedback is a filled translucent preview of the resulting rectangle — the actual
area the panel will occupy after the drop — not an outline and not a caret. The
tab-insertion case keeps a caret, because there the result *is* a position in a
row. Everything else shows the shape.

`dropTarget` is replaced by `resolveDrop(root, pointer, draggedPanel)` returning
a discriminated result:

```ts
type Drop =
  | { kind: "tab"; leafId: NodeId; index: number }
  | { kind: "split"; leafId: NodeId; edge: "left" | "right" | "top" | "bottom" };
```

The tab-bar and centre-zone intents both produce `kind: "tab"`; they differ only
in the index, which the centre zone sets to the end of the list. Six intents,
two outcomes.

Applying a drop is a pure tree transform: `applyDrop(root, drop, panelId)`.
Removing the panel from its old leaf, deleting a leaf left empty, and collapsing
a split with one remaining child are all part of that transform, so there is one
place where the tree can become malformed and one place to test.

## Blast radius

Rewritten:

- `src/lib/layout.ts` — the model, `sanitizeLayout`, `resolveDrop`, `applyDrop`,
  `visiblePanelIds`.
- `src/lib/layoutPresets.ts` — four built-ins re-expressed as trees.
- `src/lib/panelWidths.ts` — region minimums become panel minimums; ratio clamp.
- `src/components/PanelDndController.ts` — measures leaves, not four regions.
- `src/components/PanelRegion.tsx` → a recursive `LayoutNodeView`.
- `src/components/WorkspaceWorkbench.tsx` — renders the tree, not a fixed frame.
- `src/styles/final/04-modular-workbench.css` — drop preview, edit chrome; grip
  rules deleted.

Touched:

- `src/store/layout.ts` — `mutate` operates on the tree; adds edit-mode state.
- `src/lib/panelRegistry.ts` — drop `regions` and `defaultRegion`.
- `src/lib/shortcuts.ts` — the enter-edit-mode binding.
- `src/components/LayoutControls.tsx` — the Layout menu gains "Edit layout".
- `src/components/PeekCard.tsx`, `src/lib/resizeHandle.ts` — region references.

Unchanged: the archcar protocol, `layout_presets` storage, and the CLI.

## Testing

`src/lib/layout.test.ts` carries the weight, because the tree transforms are
pure:

- `applyDrop` for each of the six intents, including dropping a panel onto the
  leaf it already occupies (a no-op, not a duplicate).
- Removing the last panel from a leaf deletes the leaf and collapses its parent
  split into the sibling.
- A split never renders a child below its minimum: ratio clamping at small
  widths.
- `sanitizeLayout` returns Code for a `version: 1` object, for malformed trees,
  for unknown panel ids, and for a duplicate panel appearing in two leaves.
- Round-tripping every built-in preset through serialize/sanitize is identity.

`resolveDrop` is tested against synthetic rectangles, as `dropTarget` is today,
so no DOM is required.

Component tests cover that edit chrome renders only in edit mode and that a leaf
header is the drag surface. The existing Electron smoke recipe covers the real
window: enter edit mode, drag a panel to a leaf edge, confirm the split appears
and survives a reload.

## Risks

- **The rewrite is wide.** Nearly every layout file changes at once, and there is
  no useful half-migrated state. The plan should sequence it as model → presets →
  render → drag → edit chrome, keeping the suite green at each step rather than
  landing it as one commit.
- **Compact leaves may look wrong.** The PR bar and terminal were designed as
  fixed furniture. If `display: "compact"` does not carry them convincingly, the
  fallback is a per-panel `preferredDisplay` hint, not a return to structural
  kinds.
- **Edit mode adds a mode.** Resizing becomes two actions instead of one. This
  was accepted deliberately; if it grates in use, the narrow fix is to keep split
  handles live outside edit mode.
