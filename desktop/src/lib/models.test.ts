import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CHAT_PROVIDERS,
  MODELS,
  agentModelOptions,
  firstModel,
  modelLabel,
  providerLabel,
} from "./models";

// The generated mirrors are only trustworthy if something asserts them against
// their source, so these read model-corpus.json rather than restating the list.
interface ModelCorpus {
  providers: Record<string, { default?: string; models: { id: string; label: string }[] }>;
  retired: { id: string }[];
}

const CORPUS: ModelCorpus = JSON.parse(
  readFileSync(join(process.cwd(), "../model-corpus.json"), "utf8"),
);

// One table for every surface: the daemon's push text and the iOS app assert
// the same file, so a model reads the same wherever its notification lands.
const SHARED_LABELS: Record<string, string> = JSON.parse(
  readFileSync(join(process.cwd(), "../crates/core/tests/fixtures/model_labels.json"), "utf8"),
);

describe("model catalogue", () => {
  it("offers exactly the models the corpus declares, in order", () => {
    const expected = CHAT_PROVIDERS.flatMap((provider) =>
      CORPUS.providers[provider].models.map((model) => ({
        provider,
        model: model.id,
        value: `${provider}:${model.id}`,
        label: model.label,
        group: providerLabel(provider),
      })),
    );

    expect(agentModelOptions()).toEqual(expected);
  });

  it("starts each provider on the model the corpus defaults to", () => {
    for (const [provider, entry] of Object.entries(CORPUS.providers)) {
      if (!entry.default) continue;
      expect(firstModel(provider), provider).toBe(entry.default);
    }
  });

  it("offers no model the corpus lists as retired", () => {
    const retired = new Set(CORPUS.retired.map((entry) => entry.id));
    for (const model of Object.values(MODELS).flat()) {
      expect(retired.has(model), model).toBe(false);
    }
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
