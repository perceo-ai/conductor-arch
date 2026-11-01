import { Show, type JSX } from "solid-js";
import { layoutStore } from "@/store/layout";
import { leafWithPanel, type LayoutNode } from "@/lib/layout";
import LayoutEditBar from "./LayoutEditBar";
import LayoutNodeView from "./LayoutNodeView";

/**
 * The tree a compact workbench renders: just the leaf holding the chat panel,
 * uncollapsed. With the workspace view split, the unfocused pane is a plain
 * chat column — the inspector and every other panel follow the focused pane —
 * so two full workbenches never fight for the same width. Falls back to the
 * whole tree when no visible leaf holds chat (it was hidden from the preset).
 */
export function compactChatRoot(root: LayoutNode): LayoutNode {
  const hit = leafWithPanel(root, "chat");
  return hit ? { ...hit, collapsed: false } : root;
}

/**
 * The workspace shell: a topbar over the layout tree. There are no fixed slots
 * any more — every pane, including the one holding chat, is a leaf somewhere in
 * `layout().root`, and sizing is the tree's own business.
 *
 * `compact` renders the chat leaf alone (see compactChatRoot) and drops the
 * edit bar: structural editing belongs to the focused pane's full view.
 */
export default function WorkspaceWorkbench(props: { workspace: string; topbar: JSX.Element; compact?: boolean }) {
  const root = () =>
    props.compact ? compactChatRoot(layoutStore.layout().root) : layoutStore.layout().root;
  return (
    <div class="ws-workbench" classList={{ "workbench-editing": !props.compact && layoutStore.editing() }}>
      {props.topbar}
      <Show when={!props.compact}>
        <LayoutEditBar />
      </Show>
      <div class="ws-workbench-main">
        <LayoutNodeView node={root()} workspace={props.workspace} />
      </div>
    </div>
  );
}
