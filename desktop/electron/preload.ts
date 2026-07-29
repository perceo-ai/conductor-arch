import { contextBridge, ipcRenderer } from "electron";

// Typed, isolated bridge exposed to the renderer as window.archductor.
// The renderer never touches the socket or Node APIs directly.
const api = {
  /** Send a request to archcar; resolves with the ArchcarResponse payload. */
  request: async <Res = unknown>(payload: unknown): Promise<Res> => {
    const res = (await ipcRenderer.invoke("archcar:request", payload)) as
      | { ok: true; value: Res }
      | { ok: false; error: string };
    if (!res.ok) throw new Error(res.error);
    return res.value;
  },

  /** Ensure the event subscription is running. Idempotent. */
  ensureEvents: (): Promise<{ ok: boolean }> => ipcRenderer.invoke("archcar:subscribe"),

  /** Register a listener for the archcar event stream. Returns an unsubscribe fn. */
  onEvent: (cb: (event: unknown) => void): (() => void) => {
    const handler = (_e: unknown, event: unknown) => cb(event);
    ipcRenderer.on("archcar:event", handler);
    return () => ipcRenderer.off("archcar:event", handler);
  },

  /** Window focus changes (for foreground-gated sampling parity with gtk-app). */
  onWindowFocus: (cb: (focused: boolean) => void): (() => void) => {
    const handler = (_e: unknown, focused: boolean) => cb(focused);
    ipcRenderer.on("window:focus", handler);
    return () => ipcRenderer.off("window:focus", handler);
  },

  window: {
    minimize: () => ipcRenderer.send("window:minimize"),
    toggleMaximize: () => ipcRenderer.send("window:toggle-maximize"),
    close: () => ipcRenderer.send("window:close"),
  },
};

contextBridge.exposeInMainWorld("archductor", api);

export type ArchductorApi = typeof api;
