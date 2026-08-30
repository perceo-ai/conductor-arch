import {
  dropPreviewRect,
  resolveDrop,
  type Drop,
  type LeafRect,
  type PanelId,
  type Rect,
} from "@/lib/layout";

const THRESHOLD = 4;

export interface PanelDragState {
  panelId: PanelId;
  dragging: boolean;
  x: number;
  y: number;
  drop: Drop | null;
  preview: Rect | null;
}

export interface BeginPanelDrag {
  panelId: PanelId;
  clientX: number;
  clientY: number;
  pointerId: number;
  captureTarget: Element & {
    setPointerCapture?: (pointerId: number) => void;
    releasePointerCapture?: (pointerId: number) => void;
  };
}

interface ControllerOptions {
  /** Commits the drag. The store supplies the layout, hence `(drop, panelId)`. */
  applyDrop: (drop: Drop, panelId: PanelId) => void;
  /** Overridable so the geometry can be tested without a rendered workbench. */
  measureLeaves?: () => LeafRect[];
  onState?: (state: PanelDragState | null) => void;
  requestFrame?: (run: FrameRequestCallback) => number;
}

function boxOf(element: Element): Rect {
  const rect = element.getBoundingClientRect();
  return { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
}

/**
 * Read every rendered leaf out of the DOM. The contract is PanelLeaf's:
 * `[data-leaf-id]` roots, a `[data-tab-bar]` child whose measured height is the
 * strike zone for a tab drop, and `[data-tab-index]` shells inside it.
 */
export function measureRenderedLeaves(): LeafRect[] {
  if (typeof document === "undefined") return [];
  return [...document.querySelectorAll<HTMLElement>("[data-leaf-id]")].map((element) => {
    const bar = element.querySelector<HTMLElement>("[data-tab-bar]");
    const tabs = bar ? [...bar.querySelectorAll<HTMLElement>("[data-tab-index]")] : [];
    return {
      leafId: element.dataset.leafId ?? "",
      rect: boxOf(element),
      tabBarHeight: bar ? boxOf(bar).height : 0,
      tabs: tabs.map((tab) => {
        const box = boxOf(tab);
        return { left: box.left, width: box.width };
      }),
    };
  });
}

export function createPanelDragController(options: ControllerOptions) {
  const measureLeaves = options.measureLeaves ?? measureRenderedLeaves;
  const requestFrame = options.requestFrame ?? ((run) => window.requestAnimationFrame(run));
  let current:
    | (PanelDragState & {
        startX: number;
        startY: number;
        pointerId: number;
        captureTarget: BeginPanelDrag["captureTarget"];
      })
    | null = null;
  let framePending = false;
  let disposed = false;

  const emit = () => options.onState?.(current ? { ...current } : null);

  function measure() {
    if (!current?.dragging || disposed) return;
    const leaves = measureLeaves();
    const drop = resolveDrop(leaves, { x: current.x, y: current.y });
    const target = drop ? leaves.find((candidate) => candidate.leafId === drop.leafId) : undefined;
    current.drop = drop;
    current.preview = drop && target ? dropPreviewRect(target, drop) : null;
    emit();
  }

  function scheduleMeasure() {
    if (framePending) return;
    framePending = true;
    requestFrame(() => {
      framePending = false;
      measure();
    });
  }

  function cleanup() {
    if (!current) return;
    current.captureTarget.releasePointerCapture?.(current.pointerId);
    window.removeEventListener("pointermove", onPointerMove);
    window.removeEventListener("pointerup", onPointerUp);
    window.removeEventListener("pointercancel", onPointerCancel);
    window.removeEventListener("keydown", onKeyDown);
    document.body.classList.remove("panel-dragging");
    current = null;
    emit();
  }

  /**
   * Update the tracked pointer position and, below the 4px threshold, do
   * nothing else — a drag has not started yet. Once past it, latch
   * `dragging` and schedule a measure/resolve pass. Exposed as `move()` so
   * tests can drive the state machine without synthesizing DOM events; the
   * window `pointermove` listener below is just this same call wired to the
   * real pointer.
   */
  function move(input: { clientX: number; clientY: number }) {
    if (!current) return;
    current.x = input.clientX;
    current.y = input.clientY;
    if (!current.dragging) {
      const distance = Math.hypot(input.clientX - current.startX, input.clientY - current.startY);
      if (distance < THRESHOLD) {
        emit();
        return;
      }
      current.dragging = true;
      document.body.classList.add("panel-dragging");
    }
    scheduleMeasure();
  }

  /** Commit the resolved drop (if any) and clear state. Mirrors `pointerup`. */
  function end() {
    if (!current) return;
    if (current.dragging) measure();
    const commit = current.dragging && current.drop
      ? { panelId: current.panelId, drop: current.drop }
      : null;
    cleanup();
    if (commit) options.applyDrop(commit.drop, commit.panelId);
  }

  /** Abandon the drag without applying anything. Mirrors Escape/`pointercancel`. */
  function cancel() {
    cleanup();
  }

  function onPointerMove(event: Event) {
    const pointer = event as PointerEvent;
    move({ clientX: pointer.clientX, clientY: pointer.clientY });
  }

  function onPointerUp(event: Event) {
    if (!current) return;
    const pointer = event as PointerEvent;
    current.x = pointer.clientX;
    current.y = pointer.clientY;
    end();
  }

  function onPointerCancel() {
    cancel();
  }

  function onKeyDown(event: KeyboardEvent) {
    if (event.key !== "Escape" || !current) return;
    event.preventDefault();
    cancel();
  }

  return {
    state: () => (current ? ({ ...current } as PanelDragState) : null),
    begin(input: BeginPanelDrag) {
      cleanup();
      current = {
        panelId: input.panelId,
        dragging: false,
        x: input.clientX,
        y: input.clientY,
        startX: input.clientX,
        startY: input.clientY,
        pointerId: input.pointerId,
        captureTarget: input.captureTarget,
        drop: null,
        preview: null,
      };
      input.captureTarget.setPointerCapture?.(input.pointerId);
      window.addEventListener("pointermove", onPointerMove);
      window.addEventListener("pointerup", onPointerUp);
      window.addEventListener("pointercancel", onPointerCancel);
      window.addEventListener("keydown", onKeyDown);
      emit();
    },
    move,
    end,
    cancel,
    dispose() {
      disposed = true;
      cleanup();
    },
  };
}
