import { Show, createEffect, createSignal, createUniqueId, onCleanup, type JSX } from "solid-js";
import { Portal } from "solid-js/web";

const VIEWPORT_MARGIN = 10;
const CARD_GAP = 10;

export interface PeekPosition {
  left: number;
  top: number;
  side: "left" | "right";
}

export function computePeekPosition(
  trigger: Pick<DOMRect, "left" | "right" | "top">,
  card: Pick<DOMRect, "width" | "height">,
  viewport: { width: number; height: number },
): PeekPosition {
  const fitsRight = trigger.right + CARD_GAP + card.width <= viewport.width - VIEWPORT_MARGIN;
  const side = fitsRight ? "right" : "left";
  const left = fitsRight
    ? trigger.right + CARD_GAP
    : trigger.left - CARD_GAP - card.width;
  return {
    side,
    left: Math.max(VIEWPORT_MARGIN, Math.min(left, viewport.width - card.width - VIEWPORT_MARGIN)),
    top: Math.max(
      VIEWPORT_MARGIN,
      Math.min(trigger.top, viewport.height - card.height - VIEWPORT_MARGIN),
    ),
  };
}

export interface PeekTriggerProps {
  ref: (element: HTMLElement) => void;
  "aria-describedby": string;
  onPointerEnter?: JSX.EventHandlerUnion<HTMLElement, PointerEvent>;
  onPointerLeave?: JSX.EventHandlerUnion<HTMLElement, PointerEvent>;
  onFocus?: JSX.EventHandlerUnion<HTMLElement, FocusEvent>;
  onBlur?: JSX.EventHandlerUnion<HTMLElement, FocusEvent>;
  onKeyDown?: JSX.EventHandlerUnion<HTMLElement, KeyboardEvent>;
}

export default function PeekCard(props: {
  content: JSX.Element;
  children: (trigger: PeekTriggerProps) => JSX.Element;
  delay?: number;
}) {
  const id = `peek-${createUniqueId()}`;
  const [open, setOpen] = createSignal(false);
  const [position, setPosition] = createSignal<PeekPosition>({ left: 0, top: 0, side: "right" });
  let trigger: HTMLElement | undefined;
  let card: HTMLDivElement | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const clearTimer = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  };
  const show = () => {
    clearTimer();
    setOpen(true);
  };
  const schedule = () => {
    clearTimer();
    timer = setTimeout(show, props.delay ?? 300);
  };
  const close = () => {
    clearTimer();
    setOpen(false);
  };
  const updatePosition = () => {
    if (!trigger || !card) return;
    setPosition(
      computePeekPosition(trigger.getBoundingClientRect(), card.getBoundingClientRect(), {
        width: window.innerWidth,
        height: window.innerHeight,
      }),
    );
  };

  createEffect(() => {
    if (!open()) return;
    queueMicrotask(updatePosition);
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    onCleanup(() => {
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
    });
  });
  onCleanup(clearTimer);

  const triggerProps: PeekTriggerProps = {
    ref: (element) => {
      trigger = element;
    },
    "aria-describedby": id,
    onPointerEnter: schedule,
    onPointerLeave: close,
    onFocus: show,
    onBlur: close,
    onKeyDown: (event) => {
      if (event.key !== "Escape" || !open()) return;
      event.preventDefault();
      close();
    },
  };

  return (
    <>
      {props.children(triggerProps)}
      <Show when={open()}>
        <Portal>
          <div
            ref={card}
            id={id}
            class="peek-card"
            classList={{ "peek-card-left": position().side === "left" }}
            role="tooltip"
            style={{ left: `${position().left}px`, top: `${position().top}px` }}
          >
            {props.content}
          </div>
        </Portal>
      </Show>
    </>
  );
}
