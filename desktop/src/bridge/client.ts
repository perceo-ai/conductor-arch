// Renderer-side wrapper around the preload bridge (window.archductor).
import type { ArchcarRequest, ArchcarResponse, ArchcarEvent } from "./protocol";

interface ArchductorApi {
  request<Res = unknown>(payload: unknown): Promise<Res>;
  ensureEvents(): Promise<{ ok: boolean }>;
  onEvent(cb: (event: unknown) => void): () => void;
  onWindowFocus(cb: (focused: boolean) => void): () => void;
  window: { minimize(): void; toggleMaximize(): void; close(): void };
}

declare global {
  interface Window {
    archductor: ArchductorApi;
  }
}

const api = () => window.archductor;

/** Typed request to archcar. */
export function send<R extends ArchcarResponse = ArchcarResponse>(
  req: ArchcarRequest,
): Promise<R> {
  return api().request<R>(req);
}

/** Ensure the event stream is running and route events to a handler. */
export async function connectEvents(onEvent: (event: ArchcarEvent) => void): Promise<() => void> {
  const off = api().onEvent((e) => onEvent(e as ArchcarEvent));
  try {
    await api().ensureEvents();
  } catch (err) {
    // Don't leak the listener when startup fails; a retry re-registers cleanly.
    off();
    throw err;
  }
  return off;
}

export const onWindowFocus = (cb: (focused: boolean) => void) => api().onWindowFocus(cb);
export const windowControls = () => api().window;
