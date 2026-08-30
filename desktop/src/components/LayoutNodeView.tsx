import { Show, createSignal, onCleanup, onMount, type JSX } from "solid-js";
import { layoutStore } from "@/store/layout";
import { clampSplitRatio, panelMinPx } from "@/lib/panelWidths";
import { eachLeaf, type LayoutLeaf, type LayoutNode, type LayoutSplit, type Rect } from "@/lib/layout";
import PanelLeaf from "./PanelLeaf";
import { SplitHandle } from "./ResizeHandle";

/** The widest minimum any panel under `node` demands. */
function minPxOf(node: LayoutNode): number {
  let min = 0;
  eachLeaf(node, (candidate) => {
    for (const panel of candidate.panels) min = Math.max(min, panelMinPx(panel));
  });
  return min;
}

/**
 * A subtree that is entirely collapsed takes header height only, and its
 * sibling takes the rest — the stored ratio is ignored until it reopens.
 */
function allCollapsed(node: LayoutNode): boolean {
  let open = false;
  eachLeaf(node, (candidate) => {
    if (!candidate.collapsed) open = true;
  });
  return !open;
}

const EMPTY_RECT: Rect = { left: 0, top: 0, width: 0, height: 0 };

function SplitView(props: { node: LayoutSplit; workspace: string }) {
  let element: HTMLDivElement | undefined;
  // Ratios are stored as a fraction but clamped in pixels, so the split has to
  // know how wide it actually is before it can honour a child's minimum.
  const [availablePx, setAvailablePx] = createSignal(0);
  const measure = () => {
    if (!element) return;
    setAvailablePx(props.node.direction === "row" ? element.clientWidth : element.clientHeight);
  };
  onMount(() => {
    measure();
    const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(measure);
    if (element) observer?.observe(element);
    window.addEventListener("resize", measure);
    onCleanup(() => {
      observer?.disconnect();
      window.removeEventListener("resize", measure);
    });
  });

  const collapsed = (index: 0 | 1) => allCollapsed(props.node.children[index]);
  const clamp = (ratio: number, availableOverride?: number) => {
    const px = availableOverride ?? availablePx();
    // Before the first measurement there is nothing to clamp against; the
    // stored ratio is already inside (0, 1).
    if (px <= 0) return ratio;
    return clampSplitRatio(px, ratio, minPxOf(props.node.children[0]), minPxOf(props.node.children[1]));
  };
  const ratio = () => clamp(props.node.ratio);

  const childStyle = (index: 0 | 1): JSX.CSSProperties => {
    if (collapsed(index)) return { flex: "0 0 auto" };
    if (collapsed(index === 0 ? 1 : 0)) return { flex: "1 1 0" };
    const share = index === 0 ? ratio() : 1 - ratio();
    return { flex: `${share} 1 0` };
  };

  const rectOf = (): Rect => {
    const box = element?.getBoundingClientRect();
    return box ? { left: box.left, top: box.top, width: box.width, height: box.height } : EMPTY_RECT;
  };

  return (
    <div
      ref={element}
      class="workbench-split"
      data-split-id={props.node.id}
      data-direction={props.node.direction}
    >
      <div class="workbench-split-child" style={childStyle(0)}>
        <LayoutNodeView node={props.node.children[0]} workspace={props.workspace} />
      </div>
      <SplitHandle
        direction={props.node.direction}
        ratio={ratio}
        rect={rectOf}
        label={props.node.direction === "row" ? "Resize columns" : "Resize rows"}
        onRatio={(next) => {
          const box = rectOf();
          const available = props.node.direction === "row" ? box.width : box.height;
          layoutStore.setRatio(props.node.id, clamp(next, available));
        }}
      />
      <div class="workbench-split-child" style={childStyle(1)}>
        <LayoutNodeView node={props.node.children[1]} workspace={props.workspace} />
      </div>
    </div>
  );
}

/** Renders one node of the layout tree, recursing through splits into leaves. */
export default function LayoutNodeView(props: { node: LayoutNode; workspace: string }) {
  return (
    <Show
      when={props.node.type === "split" ? (props.node as LayoutSplit) : undefined}
      fallback={<PanelLeaf leaf={props.node as LayoutLeaf} workspace={props.workspace} />}
    >
      {(node) => <SplitView node={node()} workspace={props.workspace} />}
    </Show>
  );
}
