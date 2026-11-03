import { createSignal } from "solid-js";

// Dragging a workspace onto a pane is how the split view is arranged, so the
// drag source (a sidebar row, a pane's grab handle) and the drop targets (the
// panes) are in different components. The name in flight lives here because
// dataTransfer cannot be read during dragover — the drop zones have to learn
// what is being dragged from somewhere else to decide whether to show.

export const WORKSPACE_MIME = "application/x-archductor-workspace";

const [draggingWorkspace, setDraggingWorkspace] = createSignal<string | null>(null);

export { draggingWorkspace };

/** Props a draggable workspace handle spreads (sidebar rows, pane grips). */
export function workspaceDragProps(name: () => string) {
  return {
    draggable: true,
    onDragStart: (e: DragEvent) => {
      e.dataTransfer?.setData(WORKSPACE_MIME, name());
      e.dataTransfer?.setData("text/plain", name());
      if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
      setDraggingWorkspace(name());
    },
    onDragEnd: () => setDraggingWorkspace(null),
  };
}

/** Clear the in-flight name once a drop has been handled. */
export function endWorkspaceDrag(): void {
  setDraggingWorkspace(null);
}

/** The name a drop carries: the dataTransfer payload, or the signal as fallback. */
export function droppedWorkspace(e: DragEvent): string | null {
  return e.dataTransfer?.getData(WORKSPACE_MIME) || draggingWorkspace();
}
