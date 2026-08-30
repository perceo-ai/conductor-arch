import {
  dropCaretRect,
  dropPreviewRect,
  resolveDrop,
  type Drop,
  type LeafRect,
  type PanelId,
  type Rect,
} from "@/lib/layout";

const THRESHOLD = 4;

// Shared across whatever controller instance is live, so callers with no
// reference to it — App.tsx's global keydown handler, in particular — can
// tell a real drag gesture (pointer down and captured, even pre-threshold)
// from nothing happening, without reading DOM classes or state. A count
// rather than a bare flag so it stays correct if more than one controller
// instance is ever alive at once (tests routinely construct several).
let activeDragSessions = 0;

/** True from `begin()` until the session ends via `end()`, `cancel()`, or `dispose()`. */
export function isPanelDragActive(): boolean {
  return activeDragSessions > 0;
}

export interface PanelDragState {
  panelId: PanelId;
  dragging: boolean;
  x: number;
  y: number;
  drop: Drop | null;
  preview: Rect | null;
  /**
   * The tab-bar insertion indicator for `drop`, or `null` when the drop is a
   * split or a content-centre tab append. Computed here (where the leaf rect
   * `resolveDrop` hit is already in hand) via `dropCaretRect`, so consumers
   * — `PanelDnd.tsx` included — read the answer instead of re-deriving
   * `resolveDrop`'s tab/split boundary from `y` and `preview.top` themselves.
   */
  caret: Rect | null;
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
        /** Whether `setPointerCapture` has actually been called for this session. */
        captured: boolean;
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
    current.caret = drop && target ? dropCaretRect(target, drop, { y: current.y }) : null;
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
    if (current.captured) current.captureTarget.releasePointerCapture?.(current.pointerId);
    window.removeEventListener("pointermove", onPointerMove);
    window.removeEventListener("pointerup", onPointerUp);
    window.removeEventListener("pointercancel", onPointerCancel);
    window.removeEventListener("keydown", onKeyDown);
    document.body.classList.remove("panel-dragging");
    current = null;
    activeDragSessions = Math.max(0, activeDragSessions - 1);
    emit();
  }

  /**
   * Update the tracked pointer position and, below the 4px threshold, do
   * nothing else — a drag has not started yet. Once past it, latch
   * `dragging` and schedule a measure/resolve pass. Exposed as `move()` so
   * tests can drive the state machine without synthesizing DOM events; the
   * window `pointermove` listener below is just this same call wired to the
   * real pointer.
   *
   * Pointer capture is taken here, on the threshold crossing, not in
   * `begin()`. Capturing on pointerdown retargets the click Chromium
   * synthesizes on pointerup to the capturing element even when the pointer
   * never actually dragged — dead tab switches, dead "Hide", dead "Collapse"
   * in edit mode, all from the same bug. Below the threshold there is no
   * drag, so there must be no capture, so a plain click behaves normally.
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
      current.captured = true;
      current.captureTarget.setPointerCapture?.(current.pointerId);
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
        captured: false,
        drop: null,
        preview: null,
        caret: null,
      };
      activeDragSessions += 1;
      // No `setPointerCapture` here — see `move()`, which takes it only once
      // the drag threshold is actually crossed.
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
