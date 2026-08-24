import { createSignal,  Show,  onCleanup, onMount } from "solid-js";
import {
  type GithubRepo
} from "@/bridge/client";

// Global modal host. Renders the form for the active dialog spec. Every form
// calls into `actions.*`, which logs the action, sends the archcar request, and
// re-pulls the inventory on success.

// Chrome and helpers shared by every dialog body: the modal frame, the\n// submit-state hook, and small formatting utilities.
export function Modal(props: { title: string; onClose: () => void; children: any }) {
  let body: HTMLDivElement | undefined;
  onMount(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        props.onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    queueMicrotask(() => {
      const target = body?.querySelector<HTMLElement>(
        "input:not([disabled]), textarea:not([disabled]), select:not([disabled]), button:not([disabled])",
      );
      target?.focus();
    });
    onCleanup(() => window.removeEventListener("keydown", onKey));
  });
  return (
    <div class="modal-scrim" onClick={props.onClose}>
      <div class="modal-body dialog-card" ref={body} onClick={(e) => e.stopPropagation()}>
        <div class="dialog-header">
          <span class="dialog-title">{props.title}</span>
          <button class="ui-button-icon" title="Close" onClick={props.onClose}>
            ✕
          </button>
        </div>
        {props.children}
      </div>
    </div>
  );
}

export function useSubmit<T>(run: (v: T) => Promise<unknown>, onDone: () => void) {
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const submit = async (v: T) => {
    if (busy()) return;
    setBusy(true);
    setError(null);
    try {
      await run(v);
      onDone();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, submit };
}

/** Join a parent directory and a folder name into a destination path. */
export function joinPath(parent: string, folder: string): string {
  if (!parent) return folder;
  return `${parent.replace(/\/+$/, "")}/${folder}`;
}

/** Compact "edited 3d ago" style label from an ISO timestamp. */
export function relTime(iso: string): string {
  if (!iso) return "";
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "";
  const secs = Math.max(0, (Date.now() - then) / 1000);
  const units: [number, string][] = [
    [31536000, "y"],
    [2592000, "mo"],
    [604800, "w"],
    [86400, "d"],
    [3600, "h"],
    [60, "m"],
  ];
  for (const [size, label] of units) {
    if (secs >= size) return `${Math.floor(secs / size)}${label} ago`;
  }
  return "just now";
}

export function RepoCardAvatar(props: { repo: GithubRepo }) {
  const [broken, setBroken] = createSignal(false);
  const initials = () => (props.repo.owner || props.repo.name || "?").slice(0, 2).toUpperCase();
  return (
    <Show
      when={props.repo.avatarUrl && !broken()}
      fallback={<span class="repo-card-avatar repo-card-avatar-fallback">{initials()}</span>}
    >
      <img class="repo-card-avatar" src={props.repo.avatarUrl} alt="" loading="lazy" onError={() => setBroken(true)} />
    </Show>
  );
}
