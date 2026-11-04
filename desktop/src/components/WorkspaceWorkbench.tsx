import { Show, type JSX } from "solid-js";
import { layoutStore } from "@/store/layout";
import { leafWithPanel } from "@/lib/layout";
import LayoutEditBar from "./LayoutEditBar";
import LayoutNodeView from "./LayoutNodeView";
import { WorkbenchCompactProvider } from "./workbenchCompact";

/**
 * The workspace shell: a topbar over the layout tree. There are no fixed slots
 * any more — every pane, including the one holding chat, is a leaf somewhere in
 * `layout().root`, and sizing is the tree's own business.
 *
 * `compact` shows the chat column alone and drops the edit bar: structural
 * editing belongs to the focused pane's full view. Compact renders the *same*
 * tree with everything outside the chat leaf hidden (see `workbenchCompact`),
 * never a different tree — swapping trees on focus change remounted chat and
 * sent the transcript scrolling from the top on every switch between panes.
 * With no visible leaf holding chat (it was hidden from the preset) there is
 * nothing to compact down to, so the whole tree renders.
 */
export default function WorkspaceWorkbench(props: { workspace: string; topbar: JSX.Element; compact?: boolean }) {
  const root = () => layoutStore.layout().root;
  const chatLeafId = () => (props.compact ? leafWithPanel(root(), "chat")?.id ?? null : null);
  const compact = { active: () => chatLeafId() != null, chatLeafId };
  return (
    <div
      class="ws-workbench"
      classList={{
        "workbench-editing": !props.compact && layoutStore.editing(),
        "workbench-compact": compact.active(),
      }}
    >
      {props.topbar}
      <Show when={!props.compact}>
        <LayoutEditBar />
      </Show>
      <div class="ws-workbench-main">
        <WorkbenchCompactProvider value={compact}>
          <LayoutNodeView node={root()} workspace={props.workspace} />
        </WorkbenchCompactProvider>
      </div>
    </div>
  );
}
