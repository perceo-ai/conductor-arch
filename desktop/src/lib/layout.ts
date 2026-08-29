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
