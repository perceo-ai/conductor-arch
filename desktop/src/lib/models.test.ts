import { describe, expect, it } from "vitest";
import { agentModelOptions, firstModel, modelLabel, providerLabel } from "./models";

describe("model catalogue", () => {
  it("starts Codex on a concrete 5.6 model", () => {
    expect(firstModel("codex")).toBe("gpt-5.6-sol");
    expect(modelLabel(firstModel("codex"))).toBe("Gpt 5.6 Sol");
  });

  it("groups selectable models by provider", () => {
    expect(agentModelOptions().slice(0, 4)).toEqual([
      {
        provider: "codex",
        model: "gpt-5.6-sol",
        value: "codex:gpt-5.6-sol",
        label: "Gpt 5.6 Sol",
        group: "Codex",
      },
      {
        provider: "codex",
        model: "gpt-5.6-terra",
        value: "codex:gpt-5.6-terra",
        label: "Gpt 5.6 Terra",
        group: "Codex",
      },
      {
        provider: "codex",
        model: "gpt-5.6-luna",
        value: "codex:gpt-5.6-luna",
        label: "Gpt 5.6 Luna",
        group: "Codex",
      },
      {
        provider: "claude",
        model: "claude-fable-5",
        value: "claude:claude-fable-5",
        label: "Claude Fable 5",
        group: "Claude Code",
      },
    ]);
  });

  it("labels known providers", () => {
    expect(providerLabel("codex")).toBe("Codex");
    expect(providerLabel("claude")).toBe("Claude Code");
  });
});
