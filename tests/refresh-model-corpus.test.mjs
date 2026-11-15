// Parsing tests for the weekly corpus refresh. The network calls are not
// exercised here on purpose: what breaks silently is the extraction, and a
// refresh that mis-parses a vendor page would otherwise open a PR proposing to
// retire every model at once.
import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  codexDriftReport,
  codexMentions,
  mergeCorpus,
  parseClaudeModels,
  suggestLabel,
} from "../scripts/refresh-model-corpus.mjs";

// The Codex docs are a JS app, so the page's text is full of anchors, slugs
// and image names (gpt-55-retirement, gpt-5.6-luna.webp). That is why the
// Codex half is only ever a drift report for a human, never an automatic
// rewrite of the list.
const CODEX_PAGE = `
<a href="#gpt-6-family">GPT-6 family</a>
<h2 id="gpt-61-sol">gpt-6.1-sol</h2>
<img src="/img/gpt-6.1-sol-texture.webp">
<h2 id="gpt-61-terra">gpt-6.1-terra</h2>
<img src="/img/gpt-5.6-luna.webp">
<a href="#gpt-55-retirement">Retirements</a>
<p>gpt-5.5 retires from Codex on October 14, 2026.</p>
`;

test("ignores slugs, anchors and image names when reading the page", () => {
  const mentions = codexMentions(CODEX_PAGE);

  assert.ok(mentions.includes("gpt-6.1-sol"));
  assert.ok(mentions.includes("gpt-6.1-terra"));
  for (const noise of ["gpt-6-family", "gpt-55-retirement", "gpt-5.6-luna.webp"]) {
    assert.ok(!mentions.includes(noise), `${noise} is not a model id`);
  }
});

test("refuses a page it clearly failed to parse", () => {
  assert.throws(() => codexMentions("<html>nothing here</html>"), /parse/i);
});

test("reports a model we offer that the page no longer mentions", () => {
  const report = codexDriftReport(
    { providers: { codex: { models: [{ id: "gpt-6.1-sol" }, { id: "gpt-9-gone" }] } }, retired: [] },
    codexMentions(CODEX_PAGE),
  );

  assert.deepEqual(report.missing, ["gpt-9-gone"]);
});

test("reports an id the page mentions that we do not offer, unless it is retired", () => {
  const report = codexDriftReport(
    {
      providers: { codex: { models: [{ id: "gpt-6.1-sol" }] } },
      retired: [{ id: "gpt-5.5" }],
    },
    codexMentions(CODEX_PAGE),
  );

  assert.deepEqual(report.unknown, ["gpt-6.1-terra"]);
});

test("says nothing when the page and the corpus agree", () => {
  const report = codexDriftReport(
    {
      providers: { codex: { models: [{ id: "gpt-6.1-sol" }, { id: "gpt-6.1-terra" }] } },
      retired: [{ id: "gpt-5.5" }],
    },
    codexMentions(CODEX_PAGE),
  );

  assert.equal(report.clean, true);
});

test("reads claude ids from the models API payload", () => {
  const payload = {
    data: [
      { id: "claude-opus-5-5", display_name: "Claude Opus 5.5" },
      { id: "claude-haiku-5-5", display_name: "Claude Haiku 5.5" },
      { id: "not-a-claude-model", display_name: "Other" },
    ],
  };

  assert.deepEqual(parseClaudeModels(payload), ["claude-opus-5-5", "claude-haiku-5-5"]);
});

test("labels a dotted version the way the surfaces already do", () => {
  assert.equal(suggestLabel("claude-opus-5-5"), "Claude Opus 5.5");
  assert.equal(suggestLabel("claude-fable-5-1"), "Claude Fable 5.1");
  assert.equal(suggestLabel("claude-opus-5"), "Claude Opus 5");
  assert.equal(suggestLabel("gpt-6.1-sol"), "GPT 6.1 Sol");
});

function corpus() {
  return {
    providers: {
      codex: {
        default: "gpt-6.1-sol",
        models: [
          { id: "gpt-6.1-sol", label: "GPT 6.1 Sol" },
          { id: "gpt-6-luna", label: "GPT 6 Luna" },
        ],
      },
      claude: {
        default: "claude-opus-5",
        models: [{ id: "claude-opus-5", label: "Claude Opus 5" }],
      },
      shell: { models: [] },
    },
    retired: [],
  };
}

test("keeps the label and position of a model that is still offered", () => {
  const next = mergeCorpus(corpus(), { codex: ["gpt-6.1-sol", "gpt-6-luna"] }, "2026-11-20");

  assert.deepEqual(next.providers.codex.models, [
    { id: "gpt-6.1-sol", label: "GPT 6.1 Sol" },
    { id: "gpt-6-luna", label: "GPT 6 Luna" },
  ]);
  assert.deepEqual(next.retired, []);
});

test("appends a newly offered model with a suggested label", () => {
  // New ids land at the end rather than in the vendor's position: the order of
  // this list is a human's choice about the picker, and a refresh silently
  // reshuffling it would be a worse surprise than a new model sitting last.
  const next = mergeCorpus(
    corpus(),
    { codex: ["gpt-6.1-sol", "gpt-6.1-terra", "gpt-6-luna"] },
    "2026-11-20",
  );

  assert.deepEqual(next.providers.codex.models.map((m) => m.id), [
    "gpt-6.1-sol",
    "gpt-6-luna",
    "gpt-6.1-terra",
  ]);
  assert.equal(
    next.providers.codex.models.find((m) => m.id === "gpt-6.1-terra").label,
    "GPT 6.1 Terra",
  );
});

test("retires a model the vendor stopped listing, with the date it went", () => {
  const next = mergeCorpus(corpus(), { codex: ["gpt-6.1-sol"] }, "2026-11-20");

  assert.deepEqual(next.providers.codex.models.map((m) => m.id), ["gpt-6.1-sol"]);
  const gone = next.retired.find((entry) => entry.id === "gpt-6-luna");
  assert.ok(gone, "the dropped model should be recorded as retired");
  assert.equal(gone.retired_on, "2026-11-20");
});

test("never retires a provider's whole list", () => {
  // A vendor page that reshuffles its markup would otherwise read as "every
  // model is gone", and the refresh would propose emptying the picker.
  assert.throws(() => mergeCorpus(corpus(), { codex: [] }, "2026-11-20"), /every model/i);
});

test("leaves a provider alone when this run could not read it", () => {
  // No key, no network: the claude half is simply absent from the fetch result.
  const next = mergeCorpus(corpus(), { codex: ["gpt-6.1-sol", "gpt-6-luna"] }, "2026-11-20");

  assert.deepEqual(next.providers.claude.models.map((m) => m.id), ["claude-opus-5"]);
});

test("moves the default when the old default is gone", () => {
  const next = mergeCorpus(corpus(), { codex: ["gpt-6-luna"] }, "2026-11-20");

  assert.equal(next.providers.codex.default, "gpt-6-luna");
});
