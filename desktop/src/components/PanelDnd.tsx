import { Show, createContext, createSignal, onCleanup, useContext, type JSX } from "solid-js";
import type { PanelId, Region } from "@/lib/layout";
import { panelDescriptor } from "@/lib/panelRegistry";
import { layoutStore } from "@/store/layout";
import Icon from "./Icon";
import { createPanelDragController, type PanelDragState } from "./PanelDndController";

interface PanelDndContextValue {
  state: () => PanelDragState | null;
  begin: (event: PointerEvent, panelId: PanelId) => void;
  registerRegion: (region: Region, element: HTMLElement) => void;
}

const PanelDndContext = createContext<PanelDndContextValue>({
  state: () => null,
  begin: () => {},
  registerRegion: () => {},
});

export function usePanelDnd() {
  return useContext(PanelDndContext);
}

export default function PanelDnd(props: { children: JSX.Element }) {
  const [state, setState] = createSignal<PanelDragState | null>(null);
  const controller = createPanelDragController({
    movePanel: (panelId, region, index) => layoutStore.movePanel(panelId, region, index),
    onState: setState,
  });
  onCleanup(() => controller.dispose());
  const value: PanelDndContextValue = {
    state,
    begin(event, panelId) {
      if (event.button !== 0) return;
      controller.begin({
        panelId,
        clientX: event.clientX,
        clientY: event.clientY,
        pointerId: event.pointerId,
        captureTarget: event.currentTarget as HTMLElement,
      });
    },
    registerRegion: controller.registerRegion,
  };
  const descriptor = () => state() ? panelDescriptor(state()!.panelId) : undefined;
  return (
    <PanelDndContext.Provider value={value}>
      {props.children}
      <Show when={state()?.dragging && descriptor()}>
        {(panel) => (
          <div class="panel-drag-ghost" style={{ transform: `translate3d(${state()!.x + 12}px, ${state()!.y + 12}px, 0)` }}>
            <Icon name={panel().icon} />
            <span>{panel().title}</span>
          </div>
        )}
      </Show>
      <Show when={state()?.dragging && state()?.caret}>
        <div
          class="panel-drop-caret"
          style={{ left: `${state()!.caret!.x}px`, top: `${state()!.caret!.y}px`, height: `${state()!.caret!.height}px` }}
        />
      </Show>
    </PanelDndContext.Provider>
  );
}
