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
