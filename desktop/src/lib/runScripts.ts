import type { ArchcarRunScript } from "@/bridge/protocol";

export function runScriptAvailabilityLabel(script: ArchcarRunScript): string {
  if (!script.available_in.length) return "Local";
  if (script.available_in.includes("local") && script.available_in.includes("cloud")) return "Local + cloud";
  if (script.available_in.includes("local")) return "Local";
  if (script.available_in.includes("cloud")) return "Cloud only";
  return "Unavailable";
}

export function runScriptStatusText(script: ArchcarRunScript): string {
  if (script.runnable_here) return script.default ? "Default run script" : "Runnable here";
  return script.unavailable_reason ?? "Not available in this environment";
}

/**
 * Which controls the Setup/Run console should offer right now.
 *
 * The console used to render every button unconditionally, so "Stop Run" sat
 * there enabled with nothing running and "Run Setup" stayed clickable while a
 * script was already going. A control that cannot do anything is worse than an
 * absent one: it invites a click and answers with a toast.
 *
 * Start and stop are mutually exclusive by construction here, so the console
 * can never present both.
 */
export interface ScriptConsoleActions {
  canStart: boolean;
  canStop: boolean;
  canQueueDraft: boolean;
}

export interface ScriptConsoleInput {
  kind: "setup" | "run";
  /** A run script is live for this workspace (workspace summary `run_running`). */
  running: boolean;
  /** A start/stop request is in flight; both controls hide until it settles. */
  pending: boolean;
  /** The generated build-this-script prompt, if it loaded. */
  prompt: string;
}

export function scriptConsoleActions(input: ScriptConsoleInput): ScriptConsoleActions {
  // Only the run console tracks a long-lived process. Setup is a one-shot
  // bootstrap, so it never offers a stop control.
  const stoppable = input.kind === "run" && input.running;
  return {
    canStart: !input.pending && !stoppable,
    canStop: !input.pending && stoppable,
    // Queuing the draft into chat is unrelated to process state — it only needs
    // a prompt to have loaded.
    canQueueDraft: input.prompt.trim().length > 0,
  };
}
