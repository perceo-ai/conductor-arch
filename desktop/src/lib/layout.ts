import { panelDescriptor } from "./panelRegistry";

export type PanelId = string;

export type NodeId = string;
export type SplitDirection = "row" | "column";
export type LeafDisplay = "tabs" | "compact";

export interface LayoutLeaf {
  type: "leaf";
  id: NodeId;
  panels: PanelId[];
  active: number;
  display: LeafDisplay;
  collapsed: boolean;
}

export interface LayoutSplit {
  type: "split";
  id: NodeId;
  direction: SplitDirection;
  children: [LayoutNode, LayoutNode];
  ratio: number;
}

export type LayoutNode = LayoutLeaf | LayoutSplit;

let nodeSequence = 0;

/** Unique per node. Prefixed so a serialized layout is readable in the DB. */
export function nextNodeId(): NodeId {
  nodeSequence += 1;
  return `n${nodeSequence}-${Math.trunc(performance.now())}`;
}

export function leaf(
  panels: PanelId[],
  opts: { active?: number; display?: LeafDisplay; collapsed?: boolean; id?: NodeId } = {},
): LayoutLeaf {
  return {
    type: "leaf",
    id: opts.id ?? nextNodeId(),
    panels: [...panels],
    active: opts.active ?? 0,
    display: opts.display ?? "tabs",
    collapsed: opts.collapsed ?? false,
  };
}

export function split(
  direction: SplitDirection,
  first: LayoutNode,
  second: LayoutNode,
  ratio = 0.5,
  id?: NodeId,
): LayoutSplit {
  return { type: "split", id: id ?? nextNodeId(), direction, children: [first, second], ratio };
}

export function eachLeaf(node: LayoutNode, visit: (node: LayoutLeaf) => void): void {
  if (node.type === "leaf") {
    visit(node);
    return;
  }
  eachLeaf(node.children[0], visit);
  eachLeaf(node.children[1], visit);
}

export function findLeaf(node: LayoutNode, id: NodeId): LayoutLeaf | undefined {
  let found: LayoutLeaf | undefined;
  eachLeaf(node, (candidate) => {
    if (!found && candidate.id === id) found = candidate;
  });
  return found;
}

function isNode(value: unknown): value is LayoutNode {
  if (!value || typeof value !== "object") return false;
  const type = (value as { type?: unknown }).type;
  if (type === "leaf") {
    const node = value as Partial<LayoutLeaf>;
    return (
      typeof node.id === "string" &&
      Array.isArray(node.panels) &&
      node.panels.every((panel) => typeof panel === "string") &&
      typeof node.active === "number" &&
      Number.isFinite(node.active) &&
      (node.display === "tabs" || node.display === "compact") &&
      typeof node.collapsed === "boolean"
    );
  }
  if (type === "split") {
    const node = value as Partial<LayoutSplit>;
    return (
      typeof node.id === "string" &&
      (node.direction === "row" || node.direction === "column") &&
      Array.isArray(node.children) &&
      node.children.length === 2 &&
      typeof node.ratio === "number" &&
      Number.isFinite(node.ratio) &&
      node.children.every(isNode)
    );
  }
  return false;
}

export interface Layout {
  version: 2;
  root: LayoutNode;
}

export function isLayout(value: unknown): value is Layout {
  if (!value || typeof value !== "object") return false;
  const layout = value as Partial<Layout>;
  return layout.version === 2 && isNode(layout.root);
}

function cloneNode(node: LayoutNode): LayoutNode {
  return node.type === "leaf"
    ? { ...node, panels: [...node.panels] }
    : { ...node, children: [cloneNode(node.children[0]), cloneNode(node.children[1])] };
}

export function cloneLayout(layout: Layout): Layout {
  return { version: 2, root: cloneNode(layout.root) };
}

export function visiblePanelIds(layout: Layout): PanelId[] {
  const ids: PanelId[] = [];
  eachLeaf(layout.root, (node) => ids.push(...node.panels));
  return ids;
}

export type Drop =
  | { kind: "tab"; leafId: NodeId; index: number }
  | { kind: "split"; leafId: NodeId; edge: "left" | "right" | "top" | "bottom" };

const MIN_RATIO = 0.1;

export function leafCount(layout: Layout): number {
  let count = 0;
  eachLeaf(layout.root, () => (count += 1));
  return count;
}

/** Rebuild a tree, replacing one node. Returns the original when id is absent. */
function mapNode(node: LayoutNode, id: NodeId, replace: (node: LayoutNode) => LayoutNode): LayoutNode {
  if (node.id === id) return replace(node);
  if (node.type === "leaf") return node;
  const first = mapNode(node.children[0], id, replace);
  const second = mapNode(node.children[1], id, replace);
  if (first === node.children[0] && second === node.children[1]) return node;
  return { ...node, children: [first, second] };
}

/** Drop empty leaves, and collapse a split with one surviving child into it. */
function prune(node: LayoutNode): LayoutNode | undefined {
  if (node.type === "leaf") return node.panels.length > 0 ? node : undefined;
  const first = prune(node.children[0]);
  const second = prune(node.children[1]);
  if (first && second) {
    if (first === node.children[0] && second === node.children[1]) return node;
    return { ...node, children: [first, second] };
  }
  return first ?? second;
}

/**
 * Remove a panel from wherever it lives, pruning any leaf it emptied.
 * Returns the original root unchanged (same reference) when the panel
 * isn't present, and undefined when removal would empty the whole tree.
 */
function withPanelRemoved(root: LayoutNode, panelId: PanelId): LayoutNode | undefined {
  let changed = false;
  const strip = (node: LayoutNode): LayoutNode => {
    if (node.type === "leaf") {
      if (!node.panels.includes(panelId)) return node;
      changed = true;
      const panels = node.panels.filter((id) => id !== panelId);
      const active = Math.max(0, Math.min(node.active, panels.length - 1));
      return { ...node, panels, active };
    }
    const first = strip(node.children[0]);
    const second = strip(node.children[1]);
    if (first === node.children[0] && second === node.children[1]) return node;
    return { ...node, children: [first, second] };
  };
  const stripped = strip(root);
  return changed ? prune(stripped) : root;
}

export function removePanel(layout: Layout, panelId: PanelId): Layout {
  const next = withPanelRemoved(layout.root, panelId);
  // Undefined means the tree emptied: there must always be somewhere for
  // content to live, so refuse rather than render nothing.
  if (!next || next === layout.root) return layout;
  return { version: 2, root: next };
}

export function addPanel(layout: Layout, panelId: PanelId, leafId?: NodeId): Layout {
  if (visiblePanelIds(layout).includes(panelId)) return layout;
  let targetId = leafId;
  if (!targetId) {
    eachLeaf(layout.root, (node) => {
      if (!targetId) targetId = node.id;
    });
  }
  if (!targetId) return layout;
  // mapNode returns layout.root by reference, unchanged, when targetId
  // names no node (or names a node that isn't a leaf) — that's how an
  // explicit-but-wrong leaf id is treated as a no-op rather than cloned.
  const root = mapNode(layout.root, targetId, (node) =>
    node.type === "leaf" ? { ...node, panels: [...node.panels, panelId], active: node.panels.length } : node,
  );
  if (root === layout.root) return layout;
  return { version: 2, root };
}

export function activatePanel(layout: Layout, panelId: PanelId): Layout {
  let hit: NodeId | undefined;
  eachLeaf(layout.root, (node) => {
    if (!hit && node.panels.includes(panelId)) hit = node.id;
  });
  // Placing the panel first (when absent) means the uncollapse-and-focus
  // step below always has a real destination leaf to act on.
  const base = hit ? layout : addPanel(layout, panelId);
  let destId = hit;
  if (!destId) {
    eachLeaf(base.root, (node) => {
      if (!destId && node.panels.includes(panelId)) destId = node.id;
    });
  }
  if (!destId) return base;
  const root = mapNode(base.root, destId, (node) => {
    if (node.type !== "leaf") return node;
    const active = node.panels.indexOf(panelId);
    if (node.active === active && !node.collapsed) return node;
    return { ...node, active, collapsed: false };
  });
  if (root === base.root) return base;
  return { version: 2, root };
}

export function setCollapsed(layout: Layout, leafId: NodeId, collapsed: boolean): Layout {
  const target = findLeaf(layout.root, leafId);
  if (!target) return layout;
  if (collapsed) {
    let open = 0;
    eachLeaf(layout.root, (node) => {
      if (!node.collapsed) open += 1;
    });
    // The last open leaf stays open; otherwise nothing would render.
    if (open <= 1 && !target.collapsed) return layout;
  }
  if (target.collapsed === collapsed) return layout;
  const root = mapNode(layout.root, leafId, (node) =>
    node.type === "leaf" ? { ...node, collapsed } : node,
  );
  return { version: 2, root };
}

export function setRatio(layout: Layout, splitId: NodeId, ratio: number): Layout {
  const clamped = Math.max(MIN_RATIO, Math.min(1 - MIN_RATIO, ratio));
  // mapNode returns layout.root by reference, unchanged, when splitId
  // names no node (or names a leaf rather than a split).
  const root = mapNode(layout.root, splitId, (node) =>
    node.type === "split" ? { ...node, ratio: clamped } : node,
  );
  if (root === layout.root) return layout;
  return { version: 2, root };
}

export function applyDrop(layout: Layout, drop: Drop, panelId: PanelId): Layout {
  const target = findLeaf(layout.root, drop.leafId);
  if (!target) return layout;

  // Dropping a panel back onto the leaf that already holds it, at a spot
  // that reproduces the existing order, changes nothing: return the same
  // layout so callers can compare identity to skip persisting a no-op.
  if (drop.kind === "tab" && target.panels.includes(panelId)) {
    const without = target.panels.filter((id) => id !== panelId);
    const index = Math.max(0, Math.min(drop.index, without.length));
    const panels = [...without.slice(0, index), panelId, ...without.slice(index)];
    const unchanged = panels.length === target.panels.length && panels.every((id, i) => id === target.panels[i]);
    if (unchanged) return layout;
    const root = mapNode(layout.root, target.id, (node) =>
      node.type === "leaf" ? { ...node, panels, active: index } : node,
    );
    return { version: 2, root };
  }

  const detached = withPanelRemoved(layout.root, panelId);
  if (!detached) return layout;
  // The target may have been pruned away when the panel left it (e.g. it
  // was the only panel in its own leaf and this drop targets that leaf).
  if (!findLeaf(detached, target.id)) return layout;

  if (drop.kind === "tab") {
    const root = mapNode(detached, target.id, (node) => {
      if (node.type !== "leaf") return node;
      const index = Math.max(0, Math.min(drop.index, node.panels.length));
      return {
        ...node,
        panels: [...node.panels.slice(0, index), panelId, ...node.panels.slice(index)],
        active: index,
      };
    });
    return { version: 2, root };
  }

  const direction: SplitDirection = drop.edge === "left" || drop.edge === "right" ? "row" : "column";
  const before = drop.edge === "left" || drop.edge === "top";
  const root = mapNode(detached, target.id, (node) => {
    const moved = leaf([panelId]);
    return before ? split(direction, moved, node) : split(direction, node, moved);
  });
  return { version: 2, root };
}

export interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface LeafRect {
  leafId: NodeId;
  rect: Rect;
  tabBarHeight: number;
  tabs: Array<{ left: number; width: number }>;
}

/** Below this, an axis has no room for two usable panes. */
const MIN_SPLIT_AXIS_PX = 120;
/** The centre zone is the middle half of each axis. */
const CENTRE_FRACTION = 0.25;

function containsPointer(rect: Rect, pointer: { x: number; y: number }): boolean {
  return (
    pointer.x >= rect.left &&
    pointer.x <= rect.left + rect.width &&
    pointer.y >= rect.top &&
    pointer.y <= rect.top + rect.height
  );
}

/**
 * The splice index a drop at x would insert at: the first tab whose
 * midpoint sits to the right of the pointer, or the end of the strip when
 * the pointer is past every tab's midpoint. This is an insertion index
 * (as `applyDrop` splices with), not "which tab is under the cursor" — the
 * two differ in the right half of the last tab, which must still resolve
 * to "insert after it".
 */
function tabIndexAt(tabs: Array<{ left: number; width: number }>, x: number): number {
  const index = tabs.findIndex((tab) => x < tab.left + tab.width / 2);
  return index === -1 ? tabs.length : index;
}

/**
 * Turn a pointer position into a drop intent against a set of measured leaf
 * rectangles. Pure geometry: the caller measures the DOM, this only decides.
 *
 * The centre zone is the middle 50% of each axis, measured within the
 * leaf's content box below its tab bar; outside it, the nearer edge is
 * chosen by fraction of that axis (x/width vs y/contentHeight), not raw
 * pixels, so a wide short leaf isn't all-left-and-right. Ties go
 * horizontal. An axis under 120px offers no split on that axis.
 */
export function resolveDrop(leaves: LeafRect[], pointer: { x: number; y: number }): Drop | null {
  const hit = leaves.find((candidate) => containsPointer(candidate.rect, pointer));
  if (!hit) return null;

  if (pointer.y <= hit.rect.top + hit.tabBarHeight) {
    return { kind: "tab", leafId: hit.leafId, index: tabIndexAt(hit.tabs, pointer.x) };
  }

  const contentTop = hit.rect.top + hit.tabBarHeight;
  const contentHeight = Math.max(1, hit.rect.height - hit.tabBarHeight);
  const fx = (pointer.x - hit.rect.left) / Math.max(1, hit.rect.width);
  const fy = (pointer.y - contentTop) / contentHeight;

  const canSplitX = hit.rect.width >= MIN_SPLIT_AXIS_PX;
  const canSplitY = contentHeight >= MIN_SPLIT_AXIS_PX;
  const append: Drop = { kind: "tab", leafId: hit.leafId, index: hit.tabs.length };

  const nearX = Math.min(fx, 1 - fx);
  const nearY = Math.min(fy, 1 - fy);
  const outsideX = canSplitX && nearX < CENTRE_FRACTION;
  const outsideY = canSplitY && nearY < CENTRE_FRACTION;
  if (!outsideX && !outsideY) return append;

  // Ties go to the horizontal edge.
  const useX = outsideX && (!outsideY || nearX <= nearY);
  if (useX) return { kind: "split", leafId: hit.leafId, edge: fx < 0.5 ? "left" : "right" };
  return { kind: "split", leafId: hit.leafId, edge: fy < 0.5 ? "top" : "bottom" };
}

/** The rectangle a panel would occupy if dropped at `drop` on `target`. */
export function dropPreviewRect(target: LeafRect, drop: Drop): Rect {
  const { left, top, width, height } = target.rect;
  if (drop.kind === "tab") {
    return { left, top: top + target.tabBarHeight, width, height: height - target.tabBarHeight };
  }
  if (drop.edge === "left") return { left, top, width: width / 2, height };
  if (drop.edge === "right") return { left: left + width / 2, top, width: width / 2, height };
  if (drop.edge === "top") return { left, top, width, height: height / 2 };
  return { left, top: top + height / 2, width, height: height / 2 };
}

function logUnknownPanel(id: PanelId): void {
  console.warn(`[archductor:layout] dropping unknown panel id "${id}" while sanitising a layout`);
}

/**
 * The default layout shown when there is nothing usable to restore. This is
 * the sole source of the "Code" tree — `layoutPresets.ts` imports it rather
 * than restating the same literal, so the two can never drift apart.
 *
 * Built once at module scope so every `codeFallback()` call yields a
 * structurally identical tree, ids included: two independent fallback paths
 * (e.g. a v1 layout and a null layout) must be indistinguishable, which a
 * fresh `nextNodeId()`-minted tree per call could never satisfy. `leaf`/
 * `split` are only ever called here to build this constant, not per call.
 */
const CODE_FALLBACK: Layout = {
  version: 2,
  root: split(
    "row",
    leaf(["chat"]),
    split(
      "column",
      leaf(["pr"], { display: "compact" }),
      leaf(["summary", "files", "changes", "checks"], { active: 2 }),
      0.12,
    ),
    0.62,
  ),
};

/** A fresh clone each call — never hand back the shared constant by reference. */
export function codeFallback(): Layout {
  return cloneLayout(CODE_FALLBACK);
}

/**
 * Validate and repair an untrusted value into a v2 layout. Anything that
 * isn't a well-formed version-2 tree — including a version-1 layout, since
 * there is no migration path — falls back to `codeFallback()` outright.
 *
 * Repairs applied to an otherwise-valid tree:
 * - Unknown panel ids are dropped; a panel's first occurrence wins over any
 *   later duplicate.
 * - A leaf emptied by the above is removed, and a split left with a single
 *   surviving child collapses into that child.
 * - Ratios are clamped into (0, 1); a leaf's `active` is clamped into range.
 * - If every leaf is emptied, or if sanitising leaves no leaf uncollapsed,
 *   the whole tree falls back rather than rendering nothing.
 */
export function sanitizeLayout(value: unknown): Layout {
  if (!isLayout(value)) return codeFallback();
  const seen = new Set<PanelId>();

  const visit = (node: LayoutNode): LayoutNode | undefined => {
    if (node.type === "leaf") {
      const panels = node.panels.filter((id) => {
        if (!panelDescriptor(id)) {
          logUnknownPanel(id);
          return false;
        }
        if (seen.has(id)) return false;
        seen.add(id);
        return true;
      });
      if (panels.length === 0) return undefined;
      return { ...node, panels, active: Math.max(0, Math.min(node.active, panels.length - 1)) };
    }
    const first = visit(node.children[0]);
    const second = visit(node.children[1]);
    const ratio = Math.max(MIN_RATIO, Math.min(1 - MIN_RATIO, node.ratio));
    if (first && second) return { ...node, children: [first, second], ratio };
    return first ?? second;
  };

  const root = visit(cloneLayout(value).root);
  if (!root) return codeFallback();

  // There must always be somewhere to render.
  let open = 0;
  eachLeaf(root, (node) => {
    if (!node.collapsed) open += 1;
  });
  if (open === 0) {
    let first = true;
    eachLeaf(root, (node) => {
      if (first) {
        node.collapsed = false;
        first = false;
      }
    });
  }
  return { version: 2, root };
}
