#!/usr/bin/env node
// Refreshes model-corpus.json from what the vendors currently publish, then
// regenerates the mirrors. Run weekly by .github/workflows/model-corpus.yml,
// which opens a PR with whatever this changes.
//
//   node scripts/refresh-model-corpus.mjs
//
// It proposes; a human reviews the PR. That review is the safety net for the
// Codex half, which has no enumeration endpoint and has to be read off a docs
// page — exactly the kind of source that changes shape without warning. The
// guards below (a provider is never emptied, a page that parses to nothing is
// an error) exist so a bad read fails loudly instead of proposing to retire
// the whole picker.

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const CODEX_DOCS = "https://learn.chatgpt.com/docs/models";
const CLAUDE_MODELS_API = "https://api.anthropic.com/v1/models?limit=100";

/**
 * Model ids a Codex docs page plausibly mentions.
 *
 * The page is a JS app, so its markup is littered with section anchors
 * (`gpt-55-retirement`), image names (`gpt-5.6-luna.webp`) and collective
 * nouns (`gpt-6-family`). Those are stripped here, but what survives is still
 * only a *mention* - a retired model is named on the page too. This feeds a
 * drift report for a human; it never rewrites the list.
 */
export function codexMentions(text) {
  const plain = text
    .replace(/<[^>]+>/g, " ")
    .replace(/[\w.-]+\.(webp|png|jpg|svg)/g, " ")
    .replace(/[#"'(),]/g, " ");
  const matches = plain.match(/\bgpt-\d+(?:\.\d+)?-[a-z]+\b|\bgpt-\d+\.\d+\b/g) ?? [];
  const ids = [...new Set(matches)].filter((id) => !/-(family|retirement|and)\b/.test(id));
  if (ids.length < 2) {
    throw new Error(
      `could not parse the Codex model list from ${CODEX_DOCS}: found ${ids.length} id(s). ` +
        "The page shape probably changed; update codexMentions.",
    );
  }
  return ids;
}

/**
 * What the Codex docs and the corpus disagree about, for a human to settle.
 *
 * `missing` is the dangerous direction: a model we still offer that the page
 * has stopped naming is the shape every rotted entry had.
 */
export function codexDriftReport(corpus, mentions) {
  const offered = (corpus.providers?.codex?.models ?? []).map((model) => model.id);
  const retired = new Set((corpus.retired ?? []).map((entry) => entry.id));
  const missing = offered.filter((id) => !mentions.includes(id));
  const unknown = mentions.filter((id) => !offered.includes(id) && !retired.has(id));
  return { missing, unknown, clean: missing.length === 0 && unknown.length === 0 };
}

/** Ids from the Anthropic models API payload. */
export function parseClaudeModels(payload) {
  const data = payload?.data;
  if (!Array.isArray(data)) throw new Error("could not parse the Claude models API payload");
  return data.map((entry) => entry.id).filter((id) => typeof id === "string" && id.startsWith("claude-"));
}

/**
 * The label a surface should show for an id it has never seen.
 *
 * Trailing numeric segments are a version, not words: `claude-opus-5-5` is
 * "Claude Opus 5.5", which is why the generic formatter alone is not enough.
 */
export function suggestLabel(id) {
  const longContext = id.endsWith("[1m]");
  const base = longContext ? id.slice(0, -"[1m]".length) : id;
  const parts = base.split(/[-_]/).filter(Boolean);
  const words = [];
  for (const part of parts) {
    const isNumber = /^\d+(\.\d+)?$/.test(part);
    const previous = words[words.length - 1];
    if (isNumber && previous && /^\d+(\.\d+)?$/.test(previous)) {
      words[words.length - 1] = `${previous}.${part}`;
      continue;
    }
    words.push(
      part.toLowerCase() === "gpt" ? "GPT" : part[0]?.toUpperCase() + part.slice(1),
    );
  }
  if (longContext) words.push("1M");
  return words.join(" ");
}

/**
 * Fold a fetched id list into the corpus, preserving the labels and order a
 * human chose and recording anything the vendor dropped as retired.
 *
 * A provider missing from `fetched` was not read this run (no credentials, or
 * a failed request) and is left exactly as it was.
 */
export function mergeCorpus(corpus, fetched, today) {
  const next = structuredClone(corpus);
  next.retired = next.retired ?? [];

  for (const [provider, ids] of Object.entries(fetched)) {
    const entry = next.providers[provider];
    if (!entry) continue;
    if (ids.length === 0) {
      throw new Error(
        `refusing to retire every model of "${provider}": the vendor read returned nothing, ` +
          "which is far more likely to be a broken fetch than a real retirement.",
      );
    }

    const known = new Map((entry.models ?? []).map((model) => [model.id, model]));
    // A model we already carried keeps the position a human gave it; anything
    // new is appended rather than spliced into the vendor's order, so a
    // refresh never silently reshuffles the picker.
    const kept = (entry.models ?? []).filter((model) => ids.includes(model.id));
    const added = ids
      .filter((id) => !known.has(id))
      .map((id) => ({ id, label: suggestLabel(id) }));
    entry.models = [...kept, ...added];

    const dropped = [...known.keys()].filter((id) => !ids.includes(id));
    for (const id of dropped) {
      if (next.retired.some((retiredEntry) => retiredEntry.id === id)) continue;
      next.retired.push({
        id,
        retired_on: today,
        note: "No longer listed by the vendor; recorded by scripts/refresh-model-corpus.mjs.",
      });
    }

    if (entry.default && !ids.includes(entry.default)) entry.default = entry.models[0]?.id;
    if (entry.default && entry.models[0]?.id !== entry.default) {
      // The default has to head the list; the generator enforces this too.
      entry.models = [
        entry.models.find((model) => model.id === entry.default),
        ...entry.models.filter((model) => model.id !== entry.default),
      ];
    }
  }

  next.checked_on = today;
  return next;
}

async function fetchText(url) {
  const res = await fetch(url, { headers: { "user-agent": "archductor-model-corpus" } });
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`);
  return res.text();
}

async function main() {
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
  const corpusPath = join(repoRoot, "model-corpus.json");
  const corpus = JSON.parse(readFileSync(corpusPath, "utf8"));
  const today = new Date().toISOString().slice(0, 10);
  const reportFlag = process.argv.indexOf("--report");
  const reportPath = reportFlag === -1 ? null : process.argv[reportFlag + 1];

  // Codex: a report only. There is no enumeration endpoint, and the docs page
  // cannot be read precisely enough to rewrite the list from.
  let codex = { missing: [], unknown: [], clean: true, error: null };
  try {
    codex = codexDriftReport(corpus, codexMentions(await fetchText(CODEX_DOCS)));
  } catch (err) {
    codex = { missing: [], unknown: [], clean: true, error: err.message };
  }

  // Claude: a real list, so this half is refreshed outright.
  const fetched = {};
  let claudeError = null;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (apiKey) {
    try {
      const res = await fetch(CLAUDE_MODELS_API, {
        headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
      });
      if (!res.ok) throw new Error(`GET /v1/models -> ${res.status}`);
      fetched.claude = parseClaudeModels(await res.json());
    } catch (err) {
      claudeError = err.message;
    }
  } else {
    claudeError = "ANTHROPIC_API_KEY is not set, so the Claude list was not refreshed";
  }

  let changed = false;
  if (fetched.claude) {
    const next = mergeCorpus(corpus, fetched, today);
    const serialized = `${JSON.stringify(next, null, 2)}\n`;
    if (serialized !== readFileSync(corpusPath, "utf8")) {
      writeFileSync(corpusPath, serialized);
      changed = true;
    }
  }

  const lines = [];
  lines.push(changed ? "Claude models: corpus updated from the models API." : "Claude models: no change.");
  if (claudeError) lines.push(`Claude models: not refreshed (${claudeError}).`);
  if (codex.error) {
    lines.push(`Codex models: could not read ${CODEX_DOCS} (${codex.error}). Check it by hand.`);
  } else if (codex.clean) {
    lines.push("Codex models: the docs and the corpus agree.");
  } else {
    if (codex.missing.length > 0) {
      lines.push(
        `Codex models: **${codex.missing.join(", ")}** are offered by Archductor but no longer ` +
          `named at ${CODEX_DOCS}. Retire them in model-corpus.json if the vendor dropped them.`,
      );
    }
    if (codex.unknown.length > 0) {
      lines.push(
        `Codex models: **${codex.unknown.join(", ")}** appear in the docs but are not offered. ` +
          "Add them if they are real models.",
      );
    }
  }

  const report = `${lines.join("\n\n")}\n`;
  process.stdout.write(report);
  if (reportPath) writeFileSync(reportPath, report);

  // Exit codes the workflow reads: 0 nothing to do, 10 corpus changed (open a
  // PR), 20 a human needs to look at Codex.
  if (changed) process.exit(10);
  if (!codex.clean || codex.error) process.exit(20);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
