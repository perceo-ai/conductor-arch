import { keyboardResize, type ResizeEdge } from "@/lib/resizeHandle";

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
