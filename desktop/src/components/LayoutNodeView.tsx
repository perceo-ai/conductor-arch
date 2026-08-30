import { Show, createSignal, onCleanup, onMount, type JSX } from "solid-js";
import { layoutStore } from "@/store/layout";
import {
  COLLAPSED_HEADER_PX,
  COLLAPSED_RAIL_PX,
  clampSplitRatio,
  panelMinHeightPx,
  panelMinPx,
} from "@/lib/panelWidths";
import {
  eachLeaf,
  type LayoutLeaf,
  type LayoutNode,
  type LayoutSplit,
  type Rect,
  type SplitDirection,
} from "@/lib/layout";
import PanelLeaf from "./PanelLeaf";
import { SplitHandle } from "./ResizeHandle";

/**
 * The largest minimum any panel under `node` demands *along the split's axis*.
 * A row divides width, a column divides height, and the two have separate
 * tables — see `panelWidths.ts`.
 */
function minPxOf(node: LayoutNode, direction: SplitDirection): number {
  const minOf = direction === "row" ? panelMinPx : panelMinHeightPx;
  let min = 0;
  eachLeaf(node, (candidate) => {
    for (const panel of candidate.panels) min = Math.max(min, minOf(panel));
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
  const anyCollapsed = () => collapsed(0) || collapsed(1);
  const clamp = (ratio: number, availableOverride?: number) => {
    const px = availableOverride ?? availablePx();
    // Before the first measurement there is nothing to clamp against; the
    // stored ratio is already inside (0, 1).
    if (px <= 0) return ratio;
    const direction = props.node.direction;
    return clampSplitRatio(
      px,
      ratio,
      minPxOf(props.node.children[0], direction),
      minPxOf(props.node.children[1], direction),
    );
  };
  const ratio = () => clamp(props.node.ratio);

  /**
   * A collapsed subtree gets an explicit extent along the split's axis, never
   * `auto`: in a row `auto` resolves to the tab strip's max-content *width* —
   * roughly four tab labels — and `flex-shrink: 0` means it cannot give that
   * space back, so the "collapsed" pane stays wide and starves its sibling.
   */
  const collapsedPx = () => (props.node.direction === "row" ? COLLAPSED_RAIL_PX : COLLAPSED_HEADER_PX);

  // The basis is written `0%` rather than a bare `0`: identical to the browser,
  // but a bare zero length is a shorthand form jsdom's CSSOM discards, which
  // would make every one of these declarations untestable.
  const childStyle = (index: 0 | 1): JSX.CSSProperties => {
    if (collapsed(index)) return { flex: `0 0 ${collapsedPx()}px` };
    if (collapsed(index === 0 ? 1 : 0)) return { flex: "1 1 0%" };
    const share = index === 0 ? ratio() : 1 - ratio();
    return { flex: `${share} 1 0%` };
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
      <div
        class="workbench-split-child"
        classList={{ "workbench-split-child-collapsed": collapsed(0) }}
        style={childStyle(0)}
      >
        <LayoutNodeView node={props.node.children[0]} workspace={props.workspace} />
      </div>
      {/* While a child is collapsed the ratio does not drive anything, so a
          drag here would change nothing on screen while still forking the
          preset and scheduling a remote save. Resizing is a structural edit
          like drag, split, collapse, close, and add — all of it lives inside
          edit mode, so outside it the handle is not just visually dimmed but
          absent from the DOM: no element, no pointerdown handler, no resize. */}
      <Show when={!anyCollapsed() && layoutStore.editing()}>
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
      </Show>
      <div
        class="workbench-split-child"
        classList={{ "workbench-split-child-collapsed": collapsed(1) }}
        style={childStyle(1)}
      >
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
