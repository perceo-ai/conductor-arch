import { Index, Show, createEffect, createSignal, on, onCleanup, onMount } from "solid-js";
import { nav, restoreTabsForActiveDaemon, workspacesStore } from "@/store";
import type { Pane, SplitDirection } from "@/lib/workspacePanes";
import { draggingWorkspace, droppedWorkspace, endWorkspaceDrag } from "@/lib/workspaceDrag";
import CommandCenter from "./CommandCenter";
import { PaneProvider, paneFor } from "./paneContext";

// The workspace page: at most two panes, each showing exactly one workspace.
// There is no tab strip — the sidebar is the workspace list, and what a pane
// holds is all it holds. The focused pane's workspace is the app's selected
// workspace, so the sidebar, shortcuts, and every action keep acting on "the
// workspace on screen".
//
// Layout changes by drag: drop a workspace from the sidebar (or the other pane)
// on a pane's middle to load it there, or on the right or bottom edge of a lone
// pane to split. The sidebar's context menu offers the same splits for keyboard
// and trackpad users.

/**
 * Drop targets over a pane while a workspace is dragged. A lone pane offers its
 * right and bottom edges to split and its middle to load in place; with the
 * view already split there is no room for a third pane, so the whole pane is
 * one "show it here" target.
 */
function DropZones(props: { pane: Pane; index: number }) {
  const [over, setOver] = createSignal<SplitDirection | "here" | null>(null);
  const split = () => nav.workspacePanes().panes.length > 1;
  const show = () => {
    const name = draggingWorkspace();
    return name != null && name !== props.pane.workspace;
  };
  function zone(kind: SplitDirection | "here") {
    return {
      onDragOver: (e: DragEvent) => {
        e.preventDefault();
        if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
        setOver(kind);
      },
      onDragLeave: () => setOver((current) => (current === kind ? null : current)),
      onDrop: (e: DragEvent) => {
        e.preventDefault();
        const name = droppedWorkspace(e);
        setOver(null);
        endWorkspaceDrag();
        if (!name) return;
        if (kind === "here") nav.openWorkspaceInPane(name, props.index);
        else nav.openWorkspaceInSplit(name, kind);
      },
    };
  }
  return (
    <Show when={show()}>
      <div class="ws-pane-dropzones">
        <div class="ws-pane-dropzone ws-pane-dropzone-here" classList={{ "is-over": over() === "here" }} {...zone("here")}>
          <span>Show Here</span>
        </div>
        {/* Splitting needs a pane to split off from: a lone pane with a
            workspace in it, since an empty one has nothing to leave behind. */}
        <Show when={!split() && props.pane.workspace != null}>
          <div class="ws-pane-dropzone ws-pane-dropzone-right" classList={{ "is-over": over() === "right" }} {...zone("right")}>
            <span>Split Right</span>
          </div>
          <div class="ws-pane-dropzone ws-pane-dropzone-down" classList={{ "is-over": over() === "down" }} {...zone("down")}>
            <span>Split Down</span>
          </div>
        </Show>
      </div>
    </Show>
  );
}

function WorkspacePane(props: { pane: Pane; index: number }) {
  let root: HTMLDivElement | undefined;
  const focused = () => nav.workspacePanes().focused === props.index;
  const split = () => nav.workspacePanes().panes.length > 1;
  // Any click or keyboard focus inside a pane makes it the focused one, so the
  // sidebar highlight, shortcuts, and actions follow where the user is working.
  onMount(() => {
    const claim = (event: Event) => {
      // A pane's own grip and close button do not focus it: focusing resizes
      // the pane, which would move the control out from under the pointer
      // mid-click. Closing a pane makes its focus moot anyway.
      const target = event.target;
      if (target instanceof Element && target.closest("[data-pane-chrome]")) return;
      if (!focused()) nav.focusPane(props.index);
    };
    root?.addEventListener("pointerdown", claim, true);
    root?.addEventListener("focusin", claim, true);
    onCleanup(() => {
      root?.removeEventListener("pointerdown", claim, true);
      root?.removeEventListener("focusin", claim, true);
    });
  });
  return (
    <div
      ref={root}
      class="ws-pane"
      classList={{ "ws-pane-focused": focused(), "ws-pane-split": split() }}
      data-pane-index={props.index}
    >
      <div class="ws-pane-body">
        <Show
          when={props.pane.workspace}
          fallback={<div class="empty-state">Select a workspace from the sidebar.</div>}
        >
          {(workspace) => (
            <PaneProvider value={paneFor(workspace, focused, () => props.index)}>
              <CommandCenter workspace={workspace()} />
            </PaneProvider>
          )}
        </Show>
        <DropZones pane={props.pane} index={props.index} />
      </div>
    </div>
  );
}

export default function WorkspacePanes() {
  const panes = nav.workspacePanes;

  // Close panes whose workspace was archived or deleted, or that the daemon no
  // longer knows. Tracks the inventory only: re-running on pane changes would
  // drop a just-created workspace before its row arrives.
  createEffect(
    on(
      () => {
        if (!workspacesStore.loaded()) return null;
        return workspacesStore.state.order.map((name) => `${name}:${workspacesStore.row(name)?.status ?? ""}`).join("|");
      },
      (inventory) => {
        if (inventory == null) return;
        // A restore still owed (boot or daemon switch that could not validate
        // yet) is retried here instead: this effect fires exactly when a good
        // inventory lands, and pruning the stale panes would be wrong anyway.
        if (nav.awaitingTabRestore()) {
          const selected = nav.selectedWorkspace();
          restoreTabsForActiveDaemon();
          // What the user opened while the restore was owed wins over it.
          if (selected && workspacesStore.row(selected)?.status !== "archived" && workspacesStore.row(selected)) {
            nav.selectWorkspace(selected);
          }
          return;
        }
        nav.retainWorkspacePanes((name) => {
          const row = workspacesStore.row(name);
          return row != null && row.status !== "archived";
        });
      },
    ),
  );

  return (
    <div
      class="ws-panes"
      classList={{ "ws-panes-split": panes().panes.length > 1, "ws-panes-down": panes().direction === "down" }}
    >
      <Index each={panes().panes}>{(pane, index) => <WorkspacePane pane={pane()} index={index} />}</Index>
    </div>
  );
}
