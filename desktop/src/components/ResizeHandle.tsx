import type { Rect, SplitDirection } from "@/lib/layout";
import { dragRatio, keyboardResize, type ResizeEdge } from "@/lib/resizeHandle";

/** Keyboard nudge for a split, as a fraction of the split's own axis. */
const RATIO_STEP = 0.02;
const RATIO_LARGE_STEP = 0.1;

/**
 * The divider between a split's two children. Unlike the pixel handle below it
 * owns no size: a drag reports where the pointer landed as the first child's
 * share, and the caller clamps that against both children's minimums before
 * committing it. `rect` is read at drag time so a resized window never drags
 * against a stale box.
 */
export function SplitHandle(props: {
  direction: SplitDirection;
  ratio: () => number;
  rect: () => Rect;
  onRatio: (ratio: number) => void;
  label?: string;
}) {
  const vertical = () => props.direction === "column";

  function onPointerDown(event: PointerEvent) {
    event.preventDefault();
    const move = (moved: PointerEvent) => {
      props.onRatio(dragRatio(props.direction, props.rect(), { x: moved.clientX, y: moved.clientY }));
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      document.body.classList.remove("resizing-col", "resizing-row");
    };
    document.body.classList.add(vertical() ? "resizing-row" : "resizing-col");
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  function onKeyDown(event: KeyboardEvent) {
    const step = event.shiftKey ? RATIO_LARGE_STEP : RATIO_STEP;
    const grow = vertical() ? "ArrowDown" : "ArrowRight";
    const shrink = vertical() ? "ArrowUp" : "ArrowLeft";
    let next: number | undefined;
    if (event.key === grow) next = props.ratio() + step;
    if (event.key === shrink) next = props.ratio() - step;
    if (event.key === "Home") next = 0;
    if (event.key === "End") next = 1;
    if (next === undefined) return;
    event.preventDefault();
    props.onRatio(next);
  }

  return (
    <div
      class="resize-handle resize-handle-split"
      classList={{ "resize-handle-split-column": vertical() }}
      role="separator"
      aria-label={props.label ?? "Resize split"}
      aria-orientation={vertical() ? "horizontal" : "vertical"}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(props.ratio() * 100)}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onKeyDown={onKeyDown}
      onDblClick={() => props.onRatio(0.5)}
    />
  );
}

// A thin drag strip pinned to one edge of its (position: relative) parent.
// Dragging reports a new size to the parent, which owns the size state. `edge`
// is the parent edge the handle sits on: a right-edge handle grows the panel as
// you drag right, a left-edge handle as you drag left (the right-hand workspace
// panel), and a top-edge handle as you drag up (the bottom terminal dock).
export default function ResizeHandle(props: {
  edge: ResizeEdge;
  width: () => number;
  min: number;
  // A function is read at drag time, so a panel's ceiling can depend on the
  // current window size (see lib/panelWidths) instead of being fixed at mount.
  max: number | (() => number);
  onChange: (width: number) => void;
  label?: string;
}) {
  const vertical = () => props.edge === "top";
  const maxWidth = () => (typeof props.max === "function" ? props.max() : props.max);

  function onPointerDown(e: PointerEvent) {
    e.preventDefault();
    const startPos = vertical() ? e.clientY : e.clientX;
    const startWidth = props.width();
    const move = (ev: PointerEvent) => {
      const delta = (vertical() ? ev.clientY : ev.clientX) - startPos;
      const raw = props.edge === "right" ? startWidth + delta : startWidth - delta;
      props.onChange(Math.max(props.min, Math.min(maxWidth(), raw)));
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      document.body.classList.remove("resizing-col");
      document.body.classList.remove("resizing-row");
    };
    document.body.classList.add(vertical() ? "resizing-row" : "resizing-col");
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }
  function onKeyDown(event: KeyboardEvent) {
    const next = keyboardResize(
      props.edge,
      event.key,
      props.width(),
      props.min,
      maxWidth(),
      event.shiftKey,
    );
    if (next === undefined) return;
    event.preventDefault();
    props.onChange(next);
  }
  return (
    <div
      class="resize-handle"
      classList={{ [`resize-handle-${props.edge}`]: true }}
      role="separator"
      aria-label={props.label ?? "Resize panel"}
      aria-orientation={vertical() ? "horizontal" : "vertical"}
      aria-valuemin={props.min}
      aria-valuemax={maxWidth()}
      aria-valuenow={props.width()}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onKeyDown={onKeyDown}
      onDblClick={() => props.onChange(props.edge === "right" ? props.min : maxWidth())}
    />
  );
}
