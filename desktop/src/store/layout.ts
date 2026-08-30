import { createSignal } from "solid-js";
import {
  activatePanel as activateLayoutPanel,
  addPanel as addLayoutPanel,
  applyDrop as applyLayoutDrop,
  eachLeaf,
  removePanel as removeLayoutPanel,
  sanitizeLayout,
  setCollapsed as setLayoutCollapsed,
  setRatio as setLayoutRatio,
  visiblePanelIds,
  type Drop,
  type Layout,
  type LayoutLeaf,
  type NodeId,
  type PanelId,
} from "@/lib/layout";
import { builtinPreset, presetAfterEdit, type LayoutPreset } from "@/lib/layoutPresets";
import { workspacePanels } from "@/lib/panelRegistry";

function clone<T>(value: T): T {
  return structuredClone(value);
}

/** Every leaf in tree order. Tab cycling and focus both walk this order. */
function leavesOf(source: Layout): LayoutLeaf[] {
  const list: LayoutLeaf[] = [];
  eachLeaf(source.root, (node) => list.push(node));
  return list;
}

function normalizedPreset(source: LayoutPreset): LayoutPreset {
  const preset = clone(source);
  preset.layout = sanitizeLayout(preset.layout);
  const visible = new Set(visiblePanelIds(preset.layout));
  const known = new Set(workspacePanels().map((panel) => panel.id));
  preset.hidden = [...new Set(preset.hidden)].filter((id) => known.has(id) && !visible.has(id));
  for (const id of known) {
    if (!visible.has(id) && !preset.hidden.includes(id)) preset.hidden.push(id);
  }
  return preset;
}

const initial = normalizedPreset(builtinPreset("code")!);
const [layout, setLayout] = createSignal<Layout>(clone(initial.layout));
const [activePreset, setActivePreset] = createSignal<LayoutPreset>(clone(initial));
const [hiddenPanels, setHiddenPanels] = createSignal<PanelId[]>([...initial.hidden]);
const [focusedLeaf, setFocusedLeaf] = createSignal<NodeId | undefined>(undefined);
// Structural editing is an explicit mode: drag-to-rearrange and the close /
// collapse affordances are only live while this is true (Task 9 wires the UI).
const [editing, setEditing] = createSignal(false);
let onEdited: ((preset: LayoutPreset) => void) | undefined;

export const layoutStore = {
  layout,
  activePreset,
  hiddenPanels,
  focusedLeaf,
  setFocusedLeaf,
  editing,
  setEditing,

  onEdited(listener: ((preset: LayoutPreset) => void) | undefined) {
    onEdited = listener;
  },

  /** The leaf currently holding a panel, if any. */
  leafOf(panelId: PanelId): NodeId | undefined {
    return leavesOf(layout()).find((node) => node.panels.includes(panelId))?.id;
  },

  /**
   * The leaf a "collapse the side panel" affordance acts on. With regions gone
   * there is no named right column any more, so this is the last leaf that does
   * not hold chat — the inspector column in every built-in preset.
   */
  sidePanelLeafId(): NodeId | undefined {
    return leavesOf(layout()).filter((node) => !node.panels.includes("chat")).at(-1)?.id;
  },

  sidePanelCollapsed(): boolean {
    const id = this.sidePanelLeafId();
    return !!id && !!leavesOf(layout()).find((node) => node.id === id)?.collapsed;
  },

  toggleSidePanel() {
    const id = this.sidePanelLeafId();
    if (id) this.setCollapsed(id, !this.sidePanelCollapsed());
  },

  focusPanel(id: PanelId) {
    const escaped = id.replace(/[\\']/g, "\\$&");
    queueMicrotask(() => {
      if (typeof document !== "undefined") {
        document.querySelector<HTMLElement>(`[data-panel-id='${escaped}']`)?.focus();
      }
    });
  },

  cyclePanel(delta: 1 | -1): PanelId | undefined {
    const tabs = visiblePanelIds(layout());
    if (tabs.length === 0) return undefined;
    const focused = leavesOf(layout()).find((node) => node.id === focusedLeaf());
    const current = focused?.panels[focused.active];
    const currentIndex = Math.max(0, tabs.indexOf(current ?? tabs[0]));
    const id = tabs[(currentIndex + delta + tabs.length) % tabs.length];
    this.activatePanel(id);
    const owner = this.leafOf(id);
    if (owner) setFocusedLeaf(owner);
    this.focusPanel(id);
    return id;
  },

  applyLayout(source: LayoutPreset) {
    const preset = normalizedPreset(source);
    setActivePreset(clone(preset));
    setHiddenPanels([...preset.hidden]);
    setLayout(clone(preset.layout));
  },

  mutate(change: (current: Layout) => Layout) {
    const current = clone(layout());
    const next = sanitizeLayout(change(current));
    if (JSON.stringify(next) === JSON.stringify(layout())) return false;
    const working = presetAfterEdit(clone(activePreset()));
    setLayout(next);
    const visible = new Set(visiblePanelIds(next));
    const hidden = workspacePanels().map((panel) => panel.id).filter((id) => !visible.has(id));
    setHiddenPanels(hidden);
    const edited = { ...working, layout: clone(next), hidden: [...hidden] };
    setActivePreset(edited);
    onEdited?.(clone(edited));
    return true;
  },

  /**
   * Switching tabs is not a structural edit, so it does not fork a built-in
   * preset — unless the panel is not on screen at all, in which case placing it
   * genuinely changes the tree.
   */
  activatePanel(id: PanelId) {
    if (!visiblePanelIds(layout()).includes(id)) {
      this.mutate((current) => activateLayoutPanel(current, id));
      return;
    }
    setLayout(activateLayoutPanel(layout(), id));
  },

  /**
   * The store supplies the layout, so this takes `(drop, panelId)` where the
   * pure transform in `lib/layout.ts` takes `(layout, drop, panelId)`.
   */
  applyDrop(drop: Drop, panelId: PanelId) {
    this.mutate((current) => applyLayoutDrop(current, drop, panelId));
  },

  addPanel(id: PanelId, leafId?: NodeId) {
    this.mutate((current) => addLayoutPanel(current, id, leafId));
  },

  removePanel(id: PanelId) {
    this.mutate((current) => removeLayoutPanel(current, id));
  },

  setCollapsed(leafId: NodeId, collapsed: boolean) {
    this.mutate((current) => setLayoutCollapsed(current, leafId, collapsed));
  },

  setRatio(splitId: NodeId, ratio: number) {
    this.mutate((current) => setLayoutRatio(current, splitId, ratio));
  },

  resetToCode() {
    this.applyLayout(builtinPreset("code")!);
  },
};
