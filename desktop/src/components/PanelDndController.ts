import { dropTarget, type DropTarget, type PanelId, type PanelKind, type Region } from "@/lib/layout";
import { panelDescriptor } from "@/lib/panelRegistry";

const THRESHOLD = 4;
const REGIONS: Region[] = ["left", "center", "right", "bottom"];

export interface PanelDragState {
  panelId: PanelId;
  dragging: boolean;
  x: number;
  y: number;
  target: DropTarget | null;
  allowedRegions: Region[];
  caret?: { x: number; y: number; height: number };
}

export interface BeginPanelDrag {
  panelId: PanelId;
  clientX: number;
  clientY: number;
  pointerId: number;
  captureTarget: Element & {
    setPointerCapture?: (pointerId: number) => void;
    releasePointerCapture?: (pointerId: number) => void;
  };
}

interface ControllerOptions {
  movePanel: (panelId: PanelId, region: Region, index: number) => void;
  onState?: (state: PanelDragState | null) => void;
  requestFrame?: (run: FrameRequestCallback) => number;
}

export function createPanelDragController(options: ControllerOptions) {
  const elements = new Map<Region, HTMLElement>();
  const requestFrame = options.requestFrame ?? ((run) => window.requestAnimationFrame(run));
  let current: (PanelDragState & { startX: number; startY: number; pointerId: number; captureTarget: BeginPanelDrag["captureTarget"] }) | null = null;
  let framePending = false;
  let disposed = false;

  const emit = () => options.onState?.(current ? { ...current } : null);

  function kindElements(element: HTMLElement, kind: PanelKind, panelId: PanelId): HTMLElement[] {
    return [...element.querySelectorAll<HTMLElement>(`[data-panel-kind='${kind}']`)]
      .filter((candidate) => candidate.dataset.panelId !== panelId);
  }

  function measure() {
    if (!current?.dragging || disposed) return;
    const descriptor = panelDescriptor(current.panelId);
    if (!descriptor) return;
    const regions = REGIONS.flatMap((region) => {
      const element = elements.get(region);
      if (!element) return [];
      const box = element.getBoundingClientRect();
      return [{
        region,
        allowed: descriptor.regions.includes(region),
        rect: { left: box.left, top: box.top, width: box.width, height: box.height },
        tabs: kindElements(element, descriptor.kind, current!.panelId).map((tab) => {
          const rect = tab.getBoundingClientRect();
          return { left: rect.left, width: rect.width };
        }),
      }];
    });
    current.target = dropTarget(regions, { x: current.x, y: current.y });
    current.allowedRegions = [...descriptor.regions];
    current.caret = undefined;
    if (current.target) {
      const regionElement = elements.get(current.target.region);
      if (regionElement) {
        const items = kindElements(regionElement, descriptor.kind, current.panelId);
        const regionRect = regionElement.getBoundingClientRect();
        const before = items[current.target.index]?.getBoundingClientRect();
        const last = items.at(-1)?.getBoundingClientRect();
        current.caret = {
          x: before?.left ?? last?.right ?? regionRect.left + 10,
          y: before?.top ?? last?.top ?? regionRect.top + 10,
          height: Math.max(22, before?.height ?? last?.height ?? 28),
        };
      }
    }
    emit();
  }

  function scheduleMeasure() {
    if (framePending) return;
    framePending = true;
    requestFrame(() => {
      framePending = false;
      measure();
    });
  }

  function cleanup() {
    if (!current) return;
    current.captureTarget.releasePointerCapture?.(current.pointerId);
    window.removeEventListener("pointermove", onPointerMove);
    window.removeEventListener("pointerup", onPointerUp);
    window.removeEventListener("pointercancel", onPointerCancel);
    window.removeEventListener("keydown", onKeyDown);
    document.body.classList.remove("panel-dragging");
    current = null;
    emit();
  }

  function onPointerMove(event: Event) {
    if (!current) return;
    const pointer = event as PointerEvent;
    current.x = pointer.clientX;
    current.y = pointer.clientY;
    if (!current.dragging) {
      const distance = Math.hypot(pointer.clientX - current.startX, pointer.clientY - current.startY);
      if (distance < THRESHOLD) {
        emit();
        return;
      }
      current.dragging = true;
      document.body.classList.add("panel-dragging");
    }
    scheduleMeasure();
  }

  function onPointerUp(event: Event) {
    if (!current) return;
    const pointer = event as PointerEvent;
    current.x = pointer.clientX;
    current.y = pointer.clientY;
    if (current.dragging) measure();
    const commit = current.dragging && current.target
      ? { panelId: current.panelId, ...current.target }
      : null;
    cleanup();
    if (commit) options.movePanel(commit.panelId, commit.region, commit.index);
  }

  function onPointerCancel() {
    cleanup();
  }

  function onKeyDown(event: KeyboardEvent) {
    if (event.key !== "Escape" || !current) return;
    event.preventDefault();
    cleanup();
  }

  return {
    state: () => current ? ({ ...current } as PanelDragState) : null,
    registerRegion(region: Region, element: HTMLElement) {
      elements.set(region, element);
    },
    begin(input: BeginPanelDrag) {
      cleanup();
      current = {
        panelId: input.panelId,
        dragging: false,
        x: input.clientX,
        y: input.clientY,
        startX: input.clientX,
        startY: input.clientY,
        pointerId: input.pointerId,
        captureTarget: input.captureTarget,
        target: null,
        allowedRegions: [],
      };
      input.captureTarget.setPointerCapture?.(input.pointerId);
      window.addEventListener("pointermove", onPointerMove);
      window.addEventListener("pointerup", onPointerUp);
      window.addEventListener("pointercancel", onPointerCancel);
      window.addEventListener("keydown", onKeyDown);
      emit();
    },
    dispose() {
      disposed = true;
      cleanup();
      elements.clear();
    },
  };
}
