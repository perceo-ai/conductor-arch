import type { JSX } from "solid-js";
import { layoutStore } from "@/store/layout";
import LayoutNodeView from "./LayoutNodeView";

/**
 * The workspace shell: a topbar over the layout tree. There are no fixed slots
 * any more — every pane, including the one holding chat, is a leaf somewhere in
 * `layout().root`, and sizing is the tree's own business.
 */
export default function WorkspaceWorkbench(props: { workspace: string; topbar: JSX.Element }) {
  return (
    <div class="ws-workbench" classList={{ "workbench-editing": layoutStore.editing() }}>
      {props.topbar}
      <div class="ws-workbench-main">
        <LayoutNodeView node={layoutStore.layout().root} workspace={props.workspace} />
      </div>
    </div>
  );
}
