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
  const root = mapNode(cloneLayout(layout).root, targetId, (node) =>
    node.type === "leaf" ? { ...node, panels: [...node.panels, panelId], active: node.panels.length } : node,
  );
  return { version: 2, root };
}

export function activatePanel(layout: Layout, panelId: PanelId): Layout {
  let hit: NodeId | undefined;
  eachLeaf(layout.root, (node) => {
    if (!hit && node.panels.includes(panelId)) hit = node.id;
  });
  if (!hit) return addPanel(layout, panelId);
  const root = mapNode(cloneLayout(layout).root, hit, (node) =>
    node.type === "leaf" ? { ...node, active: node.panels.indexOf(panelId), collapsed: false } : node,
  );
  return { version: 2, root };
}

export function setCollapsed(layout: Layout, leafId: NodeId, collapsed: boolean): Layout {
  if (collapsed) {
    let open = 0;
    eachLeaf(layout.root, (node) => {
      if (!node.collapsed) open += 1;
    });
    const target = findLeaf(layout.root, leafId);
    // The last open leaf stays open; otherwise nothing would render.
    if (!target || (open <= 1 && !target.collapsed)) return layout;
  }
  const root = mapNode(cloneLayout(layout).root, leafId, (node) =>
    node.type === "leaf" ? { ...node, collapsed } : node,
  );
  return { version: 2, root };
}

export function setRatio(layout: Layout, splitId: NodeId, ratio: number): Layout {
  const clamped = Math.max(MIN_RATIO, Math.min(1 - MIN_RATIO, ratio));
  const root = mapNode(cloneLayout(layout).root, splitId, (node) =>
    node.type === "split" ? { ...node, ratio: clamped } : node,
  );
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
