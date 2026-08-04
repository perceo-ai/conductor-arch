// A thin drag strip pinned to one vertical edge of its (position: relative)
// parent. Dragging reports a new width to the parent, which owns the width
// state. `edge` is the parent edge the handle sits on: a right-edge handle
// grows the panel as you drag right; a left-edge handle grows it as you drag
// left (used by the right-hand workspace panel).
export default function ResizeHandle(props: {
  edge: "left" | "right";
  width: () => number;
  min: number;
  max: number;
  onChange: (width: number) => void;
}) {
  function onPointerDown(e: PointerEvent) {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = props.width();
    const move = (ev: PointerEvent) => {
      const dx = ev.clientX - startX;
      const raw = props.edge === "right" ? startWidth + dx : startWidth - dx;
      props.onChange(Math.max(props.min, Math.min(props.max, raw)));
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      document.body.classList.remove("resizing-col");
    };
    document.body.classList.add("resizing-col");
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }
  return (
    <div
      class="resize-handle"
      classList={{ [`resize-handle-${props.edge}`]: true }}
      onPointerDown={onPointerDown}
      onDblClick={() => props.onChange(props.edge === "right" ? props.min : props.max)}
    />
  );
}
