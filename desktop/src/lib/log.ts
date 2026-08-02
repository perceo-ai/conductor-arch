// Structured logging for every user action and store state change.
//
// Parity with the GTK app's logger.rs: each log line is forwarded to the main
// process (which appends it to a persistent logfile under the state dir) and
// mirrored to the DevTools console for live debugging. The archcar sidecar
// already logs every RPC request/response/event on its side; this covers the
// renderer half — the actions the user triggers and the state mutations they
// cause.

export type LogCategory = "action" | "state" | "rpc" | "event" | "error";

interface LogSink {
  log?: (entry: { ts: number; category: string; message: string; data?: unknown }) => void;
}

function sink(): LogSink | undefined {
  return (window as unknown as { archductor?: LogSink }).archductor;
}

function serializeData(data: unknown): unknown {
  if (data === undefined) return undefined;
  try {
    // Round-trip to strip functions/reactive proxies and keep the forwarded
    // payload structured-clone-safe for the IPC channel.
    return JSON.parse(JSON.stringify(data));
  } catch {
    return String(data);
  }
}

export function log(category: LogCategory, message: string, data?: unknown): void {
  const ts = Date.now();
  const safe = serializeData(data);
  // Mirror to console for live debugging.
  const tag = `[archductor:${category}]`;
  if (category === "error") console.error(tag, message, safe ?? "");
  else console.debug(tag, message, safe ?? "");
  // Forward to main for the persistent logfile (best-effort).
  try {
    sink()?.log?.({ ts, category, message, data: safe });
  } catch {
    // never let logging break the app
  }
}

/** Log a user-triggered action (button, menu, shortcut) before it runs. */
export const logAction = (message: string, data?: unknown) => log("action", message, data);

/** Log a store state change after it is applied. */
export const logState = (message: string, data?: unknown) => log("state", message, data);
