import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MODELS, agentModelOptions, firstModel, modelLabel, providerLabel } from "./models";

// One table for every surface: the daemon's push text and the iOS app assert
// the same file, so a model reads the same wherever its notification lands.
const SHARED_LABELS: Record<string, string> = JSON.parse(
  readFileSync(join(process.cwd(), "../crates/core/tests/fixtures/model_labels.json"), "utf8"),
);

describe("model catalogue", () => {
  it("starts Codex on a concrete 5.6 model", () => {
    expect(firstModel("codex")).toBe("gpt-5.6-sol");
    expect(modelLabel(firstModel("codex"))).toBe("GPT 5.6 Sol");
  });

  it("groups selectable models by provider", () => {
    expect(agentModelOptions()).toEqual([
      {
        provider: "codex",
        model: "gpt-5.6-sol",
        value: "codex:gpt-5.6-sol",
        label: "GPT 5.6 Sol",
        group: "Codex",
      },
      {
        provider: "codex",
        model: "gpt-5.6-terra",
        value: "codex:gpt-5.6-terra",
        label: "GPT 5.6 Terra",
        group: "Codex",
      },
      {
        provider: "codex",
        model: "gpt-5.6-luna",
        value: "codex:gpt-5.6-luna",
        label: "GPT 5.6 Luna",
        group: "Codex",
      },
      {
        provider: "codex",
        model: "gpt-5.5",
        value: "codex:gpt-5.5",
        label: "GPT 5.5",
        group: "Codex",
      },
      {
        provider: "codex",
        model: "gpt-5.4",
        value: "codex:gpt-5.4",
        label: "GPT 5.4",
        group: "Codex",
      },
      {
        provider: "claude",
        model: "claude-fable-5",
        value: "claude:claude-fable-5",
        label: "Claude Fable 5",
        group: "Claude Code",
      },
      {
        provider: "claude",
        model: "claude-opus-5",
        value: "claude:claude-opus-5",
        label: "Claude Opus 5",
        group: "Claude Code",
      },
      {
        provider: "claude",
        model: "claude-opus-4-8[1m]",
        value: "claude:claude-opus-4-8[1m]",
        label: "Claude Opus 4.8 1M",
        group: "Claude Code",
      },
      {
        provider: "claude",
        model: "claude-opus-4-7[1m]",
        value: "claude:claude-opus-4-7[1m]",
        label: "Claude Opus 4.7 1M",
        group: "Claude Code",
      },
      {
        provider: "claude",
        model: "claude-opus-4-6[1m]",
        value: "claude:claude-opus-4-6[1m]",
        label: "Claude Opus 4.6 1M",
        group: "Claude Code",
      },
      {
        provider: "claude",
        model: "claude-sonnet-5",
        value: "claude:claude-sonnet-5",
        label: "Claude Sonnet 5 1M",
        group: "Claude Code",
      },
      {
        provider: "claude",
        model: "claude-sonnet-4-6[1m]",
        value: "claude:claude-sonnet-4-6[1m]",
        label: "Claude Sonnet 4.6 1M",
        group: "Claude Code",
      },
      {
        provider: "claude",
        model: "claude-sonnet-4-6",
        value: "claude:claude-sonnet-4-6",
        label: "Claude Sonnet 4.6",
        group: "Claude Code",
      },
      {
        provider: "claude",
        model: "claude-haiku-4-5",
        value: "claude:claude-haiku-4-5",
        label: "Claude Haiku 4.5",
        group: "Claude Code",
      },
    ]);
  });

  it("labels models from the table every surface shares", () => {
    for (const [model, label] of Object.entries(SHARED_LABELS)) {
      expect(modelLabel(model), model).toBe(label);
    }
  });

  it("keeps every selectable model in the shared table", () => {
    for (const model of Object.values(MODELS).flat()) {
      expect(SHARED_LABELS, model).toHaveProperty([model]);
    }
  });

  it("labels known providers", () => {
    expect(providerLabel("codex")).toBe("Codex");
    expect(providerLabel("claude")).toBe("Claude Code");
  });
});
