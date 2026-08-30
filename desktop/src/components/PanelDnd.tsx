import { Show, createContext, createSignal, onCleanup, useContext, type JSX } from "solid-js";
import type { PanelId } from "@/lib/layout";
import { panelDescriptor } from "@/lib/panelRegistry";
import { layoutStore } from "@/store/layout";
import Icon from "./Icon";
import { createPanelDragController, type PanelDragState } from "./PanelDndController";

interface PanelDndContextValue {
  state: () => PanelDragState | null;
  begin: (event: PointerEvent, panelId: PanelId) => void;
}

const PanelDndContext = createContext<PanelDndContextValue>({
  state: () => null,
  begin: () => {},
});

export function usePanelDnd() {
  return useContext(PanelDndContext);
}

export default function PanelDnd(props: { children: JSX.Element }) {
  const [state, setState] = createSignal<PanelDragState | null>(null);
  const controller = createPanelDragController({
    applyDrop: (drop, panelId) => layoutStore.applyDrop(drop, panelId),
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
  };
  const descriptor = () => (state() ? panelDescriptor(state()!.panelId) : undefined);
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
      <Show when={state()?.dragging && state()?.preview}>
        {(preview) => (
          <div
            class="panel-drop-preview"
            style={{
              left: `${preview().left}px`,
              top: `${preview().top}px`,
              width: `${preview().width}px`,
              height: `${preview().height}px`,
            }}
          />
        )}
      </Show>
    </PanelDndContext.Provider>
  );
}
