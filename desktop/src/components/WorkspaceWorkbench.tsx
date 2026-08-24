import { For, Show, createSignal, onCleanup, onMount, type JSX } from "solid-js";
import type { Region } from "@/lib/layout";
import { layoutStore } from "@/store/layout";
import { BOTTOM_MAX, BOTTOM_MIN, CENTER_MIN, LEFT_MAX, LEFT_MIN, RIGHT_MAX, RIGHT_MIN, panelDragMax } from "@/lib/panelWidths";
import PanelRegion from "./PanelRegion";
import ResizeHandle from "./ResizeHandle";
import { usePanelDnd } from "./PanelDnd";

const SIDE_REGIONS: Region[] = ["left", "center", "right"];

function hasContent(region: Region) {
  const stack = layoutStore.layout().regions[region];
  return stack.panels.length + stack.strips.length + stack.docks.length > 0;
}

export default function WorkspaceWorkbench(props: { workspace: string; topbar: JSX.Element }) {
  const dnd = usePanelDnd();
  let workbench: HTMLDivElement | undefined;
  const [availableWidth, setAvailableWidth] = createSignal(typeof window === "undefined" ? Number.POSITIVE_INFINITY : window.innerWidth);
  const measure = () => setAvailableWidth(workbench?.clientWidth || window.innerWidth);
  onMount(() => {
    measure();
    window.addEventListener("resize", measure);
    const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(measure);
    if (workbench) observer?.observe(workbench);
    onCleanup(() => {
      window.removeEventListener("resize", measure);
      observer?.disconnect();
    });
  });

  const autoCollapsed = (region: "left" | "right") => {
    const left = hasContent("left") && !layoutStore.layout().regions.left.collapsed;
    const right = hasContent("right") && !layoutStore.layout().regions.right.collapsed;
    const leftAuto = left && availableWidth() < CENTER_MIN + LEFT_MIN + (right ? RIGHT_MIN : 0);
    if (region === "left") return leftAuto;
    return right && availableWidth() < CENTER_MIN + (left && !leftAuto ? LEFT_MIN : 0) + RIGHT_MIN;
  };
  const visible = (region: Region) =>
    region === "center" || (
      (!!dnd.state()?.dragging && dnd.state()!.allowedRegions.includes(region)) ||
      hasContent(region) &&
      !layoutStore.layout().regions[region].collapsed &&
      (region !== "left" && region !== "right" || !autoCollapsed(region))
    );
  const regionStyle = (region: Region): JSX.CSSProperties => {
    const size = layoutStore.layout().regions[region].size;
    if (region === "left" || region === "right") {
      return { width: `${size}px`, "flex-basis": `${size}px` };
    }
    if (region === "bottom") return { height: `${size}px` };
    return {};
  };

  return (
      <div class="ws-workbench" ref={workbench}>
        <div class="ws-workbench-main">
          <For each={SIDE_REGIONS}>
            {(region) => (
              <Show when={visible(region)}>
                <div class={`ws-workbench-region-shell ws-workbench-region-shell-${region}`} style={regionStyle(region)}>
                  <Show when={region === "center"}>{props.topbar}</Show>
                  <PanelRegion workspace={props.workspace} region={region} />
                  <Show when={region === "left"}>
                    <ResizeHandle
                      edge="right"
                      width={() => layoutStore.layout().regions.left.size}
                      min={LEFT_MIN}
                      max={() => panelDragMax({ viewportWidth: availableWidth(), otherPanelWidth: visible("right") ? layoutStore.layout().regions.right.size : 0, hardMax: LEFT_MAX, panelMin: LEFT_MIN })}
                      onChange={(size) => layoutStore.resizeRegion("left", size)}
                      label="Resize left region"
                    />
                  </Show>
                  <Show when={region === "right"}>
                    <ResizeHandle
                      edge="left"
                      width={() => layoutStore.layout().regions.right.size}
                      min={RIGHT_MIN}
                      max={() => panelDragMax({ viewportWidth: availableWidth(), otherPanelWidth: visible("left") ? layoutStore.layout().regions.left.size : 0, hardMax: RIGHT_MAX, panelMin: RIGHT_MIN })}
                      onChange={(size) => layoutStore.resizeRegion("right", size)}
                      label="Resize right region"
                    />
                  </Show>
                </div>
              </Show>
            )}
          </For>
        </div>
        <Show when={visible("bottom")}>
          <div class="ws-workbench-region-shell ws-workbench-region-shell-bottom" style={regionStyle("bottom")}>
            <PanelRegion workspace={props.workspace} region="bottom" />
            <ResizeHandle
              edge="top"
              width={() => layoutStore.layout().regions.bottom.size}
              min={BOTTOM_MIN}
              max={BOTTOM_MAX}
              onChange={(size) => layoutStore.resizeRegion("bottom", size)}
              label="Resize bottom region"
            />
          </div>
        </Show>
      </div>
  );
}
