import { Show } from "solid-js";
import { nav } from "@/store";
import Icon from "@/components/Icon";
import { titleCaseWorkspace } from "@/lib/text";
import { workspaceDragProps } from "@/lib/workspaceDrag";
import { usePane } from "./paneContext";

/**
 * A split pane's own controls, at the end of its topbar actions: a grip that
 * drags this workspace to the other pane, and a close button that unsplits.
 * With one pane there is nothing to drag to and nothing to unsplit, so neither
 * is rendered — a single workspace keeps its header exactly as it was.
 *
 * `data-pane-chrome` exempts these from the pane's focus-on-pointerdown claim.
 * Focusing a pane widens it and adds the focused-pane controls, which moves
 * every control in its header — pressing the close button on the *unfocused*
 * pane would slide it out from under the pointer before the release, and the
 * click would land on whatever took its place.
 */
export default function PaneChrome(props: { workspace: string }) {
  const pane = usePane();
  const split = () => nav.workspacePanes().panes.length > 1;
  return (
    <Show when={split()}>
      <span class="ws-pane-chrome" data-pane-chrome>
        <span
          class="ws-pane-grip ws-topbar-btn"
          title={`Drag ${titleCaseWorkspace(props.workspace)} to the other pane`}
          {...workspaceDragProps(() => props.workspace)}
        >
          <Icon name="grip-vertical" />
        </span>
        <button
          class="ui-button-icon ws-topbar-btn ws-pane-close"
          title="Close split"
          aria-label={`Close ${titleCaseWorkspace(props.workspace)} pane`}
          onClick={() => nav.closePane(pane.index())}
        >
          <Icon name="x" />
        </button>
      </span>
    </Show>
  );
}
