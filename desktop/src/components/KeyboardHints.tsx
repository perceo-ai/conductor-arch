import { For, Show, createSignal, onCleanup, onMount } from "solid-js";
import { Portal } from "solid-js/web";

interface KeyboardHint {
  label: string;
  left: number;
  top: number;
}

function isVisible(element: HTMLElement): boolean {
  if (
    !element.isConnected ||
    element.hasAttribute("disabled") ||
    element.getAttribute("aria-disabled") === "true"
  ) return false;
  let current: HTMLElement | null = element;
  while (current) {
    const style = window.getComputedStyle(current);
    if (style.display === "none" || style.visibility === "hidden") return false;
    current = current.parentElement;
  }
  const rect = element.getBoundingClientRect();
  return (
    rect.width > 0 &&
    rect.height > 0 &&
    rect.bottom > 0 &&
    rect.right > 0 &&
    rect.top < window.innerHeight &&
    rect.left < window.innerWidth
  );
}

function collectHints(): KeyboardHint[] {
  return Array.from(document.querySelectorAll<HTMLElement>("[data-shortcut]"))
    .filter(isVisible)
    .map((element) => {
      const rect = element.getBoundingClientRect();
      return {
        label: element.dataset.shortcut ?? "",
        left: Math.max(6, Math.min(rect.right - 4, window.innerWidth - 6)),
        top: Math.max(6, Math.min(rect.top - 7, window.innerHeight - 6)),
      };
    })
    .filter((hint) => hint.label.length > 0);
}

// Holding Alt reveals the app's actual configured shortcuts beside visible
// controls. This layer is deliberately observational: it never prevents the
// modifier event, changes focus, or adds a second way to activate a control.
export default function KeyboardHints() {
  const [active, setActive] = createSignal(false);
  const [hints, setHints] = createSignal<KeyboardHint[]>([]);

  const refresh = () => {
    if (active()) setHints(collectHints());
  };
  const show = () => {
    setHints(collectHints());
    setActive(true);
  };
  const hide = () => {
    setActive(false);
    setHints([]);
  };

  onMount(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Alt") show();
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.key === "Alt") hide();
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", hide);
    window.addEventListener("resize", refresh);
    window.addEventListener("scroll", refresh, true);
    onCleanup(() => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", hide);
      window.removeEventListener("resize", refresh);
      window.removeEventListener("scroll", refresh, true);
    });
  });

  return (
    <Show when={active()}>
      <Portal>
        <div class="keyboard-hint-layer" aria-hidden="true">
          <For each={hints()}>
            {(hint) => (
              <kbd
                class="keyboard-hint"
                style={{ left: `${hint.left}px`, top: `${hint.top}px` }}
              >
                {hint.label}
              </kbd>
            )}
          </For>
        </div>
      </Portal>
    </Show>
  );
}
