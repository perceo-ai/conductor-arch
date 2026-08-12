import { describe, expect, it } from "vitest";
import { runScriptAvailabilityLabel, runScriptStatusText } from "./runScripts";
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
