import { For, Show, type JSX } from "solid-js";
import type { Region } from "@/lib/layout";
import { layoutStore } from "@/store/layout";
import PanelRegion from "./PanelRegion";

const SIDE_REGIONS: Region[] = ["left", "center", "right"];

function hasContent(region: Region) {
  const stack = layoutStore.layout().regions[region];
  return stack.panels.length + stack.strips.length + stack.docks.length > 0;
}

export default function WorkspaceWorkbench(props: { workspace: string; topbar: JSX.Element }) {
  const visible = (region: Region) =>
    region === "center" || (hasContent(region) && !layoutStore.layout().regions[region].collapsed);
  const regionStyle = (region: Region): JSX.CSSProperties => {
    const size = layoutStore.layout().regions[region].size;
    if (region === "left" || region === "right") {
      return { width: `${size}px`, "flex-basis": `${size}px` };
    }
    if (region === "bottom") return { height: `${size}px` };
    return {};
  };

  return (
    <div class="ws-workbench">
      <div class="ws-workbench-main">
        <For each={SIDE_REGIONS}>
          {(region) => (
            <Show when={visible(region)}>
              <div class={`ws-workbench-region-shell ws-workbench-region-shell-${region}`} style={regionStyle(region)}>
                <Show when={region === "center"}>{props.topbar}</Show>
                <PanelRegion workspace={props.workspace} region={region} />
              </div>
            </Show>
          )}
        </For>
      </div>
      <Show when={visible("bottom")}>
        <div class="ws-workbench-region-shell ws-workbench-region-shell-bottom" style={regionStyle("bottom")}>
          <PanelRegion workspace={props.workspace} region="bottom" />
        </div>
      </Show>
    </div>
  );
}
