import { describe, expect, it } from "vitest";
import { runScriptAvailabilityLabel, runScriptStatusText, scriptConsoleActions } from "./runScripts";
import type { ArchcarRunScript } from "@/bridge/protocol";

function script(fields: Partial<ArchcarRunScript>): ArchcarRunScript {
  return {
    id: "dev",
    command: "pnpm dev",
    available_in: [],
    default: false,
    runnable_here: true,
    ...fields,
  };
}

describe("run script labels", () => {
  it("labels local and cloud availability without exposing commands", () => {
    expect(runScriptAvailabilityLabel(script({ available_in: [] }))).toBe("Local");
    expect(runScriptAvailabilityLabel(script({ available_in: ["local", "cloud"] }))).toBe("Local + cloud");
    expect(runScriptAvailabilityLabel(script({ available_in: ["cloud"], runnable_here: false }))).toBe("Cloud only");
  });

  it("reports disabled cloud-only scripts with the server reason", () => {
    expect(runScriptStatusText(script({ default: true }))).toBe("Default run script");
    expect(
      runScriptStatusText(
        script({
          available_in: ["cloud"],
          runnable_here: false,
          unavailable_reason: "Available only in cloud workspaces.",
        }),
      ),
    ).toBe("Available only in cloud workspaces.");
  });
});

describe("scriptConsoleActions", () => {
  const base = { kind: "run" as const, running: false, pending: false, prompt: "build it" };

  it("offers start, and no stop, when nothing is running", () => {
    expect(scriptConsoleActions(base)).toMatchObject({ canStart: true, canStop: false });
  });

  it("offers stop, and no start, while a run is live", () => {
    expect(scriptConsoleActions({ ...base, running: true })).toMatchObject({
      canStart: false,
      canStop: true,
    });
  });

  it("never offers start and stop at the same time", () => {
    for (const running of [false, true]) {
      for (const pending of [false, true]) {
        const a = scriptConsoleActions({ ...base, running, pending });
        expect(a.canStart && a.canStop).toBe(false);
      }
    }
  });

  it("hides both while a request is in flight, so a click cannot double-fire", () => {
    expect(scriptConsoleActions({ ...base, pending: true })).toMatchObject({
      canStart: false,
      canStop: false,
    });
    expect(scriptConsoleActions({ ...base, running: true, pending: true })).toMatchObject({
      canStart: false,
      canStop: false,
    });
  });

  it("never offers stop for setup, which is a one-shot bootstrap", () => {
    expect(scriptConsoleActions({ ...base, kind: "setup", running: true })).toMatchObject({
      canStart: true,
      canStop: false,
    });
  });

  it("gates the queue-draft action on a prompt having loaded", () => {
    expect(scriptConsoleActions({ ...base, prompt: "" }).canQueueDraft).toBe(false);
    expect(scriptConsoleActions({ ...base, prompt: "   " }).canQueueDraft).toBe(false);
    expect(scriptConsoleActions({ ...base, prompt: "do it" }).canQueueDraft).toBe(true);
  });

  it("keeps queue-draft independent of process state", () => {
    // Queuing the prompt into chat is unrelated to whether a script is running.
    expect(scriptConsoleActions({ ...base, running: true, pending: true }).canQueueDraft).toBe(true);
  });
});
