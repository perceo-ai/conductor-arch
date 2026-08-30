import { Show, createContext, createMemo, createSignal, onCleanup, useContext, type JSX } from "solid-js";
import type { PanelId, Rect } from "@/lib/layout";
import { panelDescriptor } from "@/lib/panelRegistry";
import { layoutStore } from "@/store/layout";
import Icon from "./Icon";
import { createPanelDragController, measureRenderedLeaves, type PanelDragState } from "./PanelDndController";

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

  /**
   * The filled preview always shows the whole rectangle a "tab" drop would
   * occupy (dropPreviewRect doesn't distinguish "over the bar" from "over
   * the content, append at the end" — both yield the same content rect). The
   * caret adds the one thing the preview can't: *which* slot among the tabs
   * the panel would land in. Only worth drawing while the pointer is
   * actually over the bar — `y <= preview.top` is exactly resolveDrop's own
   * boundary between "tab" and "split", re-derived here rather than plumbed
   * through PanelDragState.
   */
  const caret = createMemo<Rect | null>(() => {
    const current = state();
    const drop = current?.drop;
    const preview = current?.preview;
    if (!current?.dragging || !drop || !preview || drop.kind !== "tab") return null;
    if (current.y > preview.top) return null;
    const target = measureRenderedLeaves().find((leaf) => leaf.leafId === drop.leafId);
    if (!target) return null;
    const left = drop.index < target.tabs.length
      ? target.tabs[drop.index]!.left
      : target.rect.left + target.rect.width;
    return { left, top: target.rect.top, width: 2, height: target.tabBarHeight };
  });

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
      <Show when={caret()}>
        {(rect) => (
          <div
            class="panel-drop-caret"
            style={{
              left: `${rect().left}px`,
              top: `${rect().top}px`,
              width: `${rect().width}px`,
              height: `${rect().height}px`,
            }}
          />
        )}
      </Show>
    </PanelDndContext.Provider>
  );
}
