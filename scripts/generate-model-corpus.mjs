#!/usr/bin/env node
// Writes every model-list mirror from model-corpus.json.
//
// The selectable model list used to live in five hand-maintained places, so
// adding one model meant five edits and the list quietly rotted until it
// offered ids the provider CLIs had retired. The daemon passes `--model <id>`
// through without validating it, so a stale entry is not a cosmetic problem:
// the chat dies at the provider.
//
//   node scripts/generate-model-corpus.mjs                  # rewrite the mirrors
//   node scripts/generate-model-corpus.mjs --check          # fail if they drifted
//   node scripts/generate-model-corpus.mjs --max-age 60     # also fail if stale
//
// `--check` is what CI and the release workflows run; it never writes. The
// weekly CI run adds `--max-age`, which fails once nobody has re-read the
// vendors' model pages in that many days. Neither provider CLI can enumerate
// its own models, so that nag is the mechanism: it is cheap and deterministic,
// where scraping a docs page into a release is neither.

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const MARK_BEGIN = "generated from model-corpus.json by scripts/generate-model-corpus.mjs";
const MARK_END = "end generated from model-corpus.json";

const args = process.argv.slice(2);
const check = args.includes("--check");
const maxAgeFlag = args.indexOf("--max-age");
const maxAgeDays = maxAgeFlag === -1 ? null : Number(args[maxAgeFlag + 1]);
const repoFlag = args.indexOf("--repo");
const repoRoot =
  repoFlag === -1
    ? join(dirname(fileURLToPath(import.meta.url)), "..")
    : args[repoFlag + 1];

const corpusPath = join(repoRoot, "model-corpus.json");
const corpus = JSON.parse(readFileSync(corpusPath, "utf8"));

// Staleness is the failure this whole file exists to prevent, so it is checked
// before anything else: a corpus can be perfectly in sync with itself and still
// offer models the provider dropped months ago.
if (maxAgeDays !== null) {
  if (!Number.isFinite(maxAgeDays) || maxAgeDays <= 0) {
    console.error(`--max-age needs a positive number of days, got ${args[maxAgeFlag + 1]}`);
    process.exit(2);
  }
  const checkedOn = Date.parse(`${corpus.checked_on}T00:00:00Z`);
  if (Number.isNaN(checkedOn)) {
    console.error(`model-corpus.json: checked_on is not a YYYY-MM-DD date (${corpus.checked_on})`);
    process.exit(1);
  }
  const ageDays = Math.floor((Date.now() - checkedOn) / 86_400_000);
  if (ageDays > maxAgeDays) {
    console.error(
      `model-corpus.json was last checked against the vendors ${ageDays} days ago (limit ${maxAgeDays}).\n` +
        `Re-read ${Object.values(corpus.sources ?? {}).join(" and ")}, update the models and the\n` +
        "retired list, set checked_on to today, and run: node scripts/generate-model-corpus.mjs",
    );
    process.exit(1);
  }
  console.log(`model corpus was checked against the vendors ${ageDays} day(s) ago`);
}

/** The label every surface derives when it has no explicit arm for an id. */
function genericLabel(model) {
  const longContext = model.endsWith("[1m]");
  const base = longContext ? model.slice(0, -"[1m]".length) : model;
  const parts = base
    .split(/[-_]/)
    .filter(Boolean)
    .map((part) =>
      part.toLowerCase() === "gpt" ? "GPT" : part[0]?.toUpperCase() + part.slice(1),
    );
  if (longContext) parts.push("1M");
  return parts.join(" ");
}

const providers = corpus.providers ?? {};
const providerNames = Object.keys(providers);
const allModels = providerNames.flatMap((name) => providers[name].models ?? []);
const retired = corpus.retired ?? [];

// Refuse to ship a model the corpus itself records as retired. Catching this
// here is the point of keeping the retired list in the same file.
const retiredById = new Map(retired.map((entry) => [entry.id, entry]));
const shippingRetired = allModels.filter((model) => retiredById.has(model.id));
if (shippingRetired.length > 0) {
  const lines = shippingRetired.map((model) => {
    const entry = retiredById.get(model.id);
    return `  ${model.id} — retired ${entry.retired_on}: ${entry.note ?? "no note"}`;
  });
  console.error(
    `model-corpus.json offers ${shippingRetired.length} model(s) it also lists as retired:\n${lines.join("\n")}\n` +
      "Remove them from providers, or drop them from the retired list if they came back.",
  );
  process.exit(1);
}

// Every surface takes the default from the head of the list (`firstModel`,
// `CODEX_DEFAULT_MODEL`), so the declared default has to be the first entry or
// the two disagree and the picker opens on a model nobody chose.
for (const [name, provider] of Object.entries(providers)) {
  const ids = (provider.models ?? []).map((model) => model.id);
  if (!provider.default) continue;
  if (!ids.includes(provider.default)) {
    console.error(
      `model-corpus.json: provider "${name}" defaults to ${provider.default}, which it does not offer.`,
    );
    process.exit(1);
  }
  if (ids[0] !== provider.default) {
    console.error(
      `model-corpus.json: provider "${name}" defaults to ${provider.default}, but lists ${ids[0]} first. ` +
        "The default must head the list.",
    );
    process.exit(1);
  }
}

/** Models whose label the generic formatter gets wrong, so each surface needs an arm. */
const explicit = allModels.filter((model) => genericLabel(model.id) !== model.label);

const quoted = (value) => JSON.stringify(value);

function listBlock(indent, ids) {
  if (ids.length === 0) return "[]";
  const inner = ids.map((id) => `${indent}  ${quoted(id)},`).join("\n");
  return `[\n${inner}\n${indent}]`;
}

const desktopModels = () => {
  const body = providerNames
    .map((name) => `  ${name}: ${listBlock("  ", (providers[name].models ?? []).map((m) => m.id))},`)
    .join("\n");
  return `export const MODELS: Record<string, string[]> = {\n${body}\n};`;
};

const desktopLabels = () =>
  explicit.map((m) => `  if (model === ${quoted(m.id)}) return ${quoted(m.label)};`).join("\n");

const swiftModels = () => {
  const body = providerNames
    .map((name) => {
      const ids = (providers[name].models ?? []).map((m) => m.id);
      if (ids.length === 0) return `        ${quoted(name)}: [],`;
      const inner = ids.map((id) => `            ${quoted(id)},`).join("\n");
      return `        ${quoted(name)}: [\n${inner}\n        ],`;
    })
    .join("\n");
  return `    public static let models: [String: [String]] = [\n${body}\n    ]`;
};

const swiftLabels = () =>
  explicit.map((m) => `        case ${quoted(m.id)}: return ${quoted(m.label)}`).join("\n");

const rustRegistry = () => {
  const lines = [];
  for (const name of providerNames) {
    const ids = (providers[name].models ?? []).map((m) => m.id);
    if (ids.length === 0) continue;
    const constName = `${name.toUpperCase()}_MODEL_CHOICES`;
    const def = providers[name].default;
    if (def) {
      lines.push(`pub const ${name.toUpperCase()}_DEFAULT_MODEL: &str = ${quoted(def)};`);
    }
    // rustfmt would collapse a short array onto one line, which would make
    // `cargo fmt` and this generator fight over the same file: each would
    // "fix" the other's output and both CI gates could never be green at once.
    lines.push("#[rustfmt::skip]");
    lines.push(`pub const ${constName}: &[&str] = &[`);
    lines.push(...ids.map((id) => `    ${quoted(id)},`));
    lines.push("];");
    lines.push("");
  }
  return lines.join("\n").trimEnd();
};

const rustLabels = () =>
  explicit
    .map((m) => `        ${quoted(m.id)} => return ${quoted(m.label)}.to_owned(),`)
    .join("\n");

/**
 * The shared label fixture. Entries the corpus does not own are kept: the
 * fallback-formatting tests rely on synthetic ids that are deliberately not
 * selectable models.
 */
function labelFixture(existingText) {
  const existing = JSON.parse(existingText);
  const owned = new Set(allModels.map((m) => m.id));
  const out = {};
  for (const model of allModels) out[model.id] = model.label;
  for (const [id, label] of Object.entries(existing)) {
    if (!owned.has(id)) out[id] = label;
  }
  return `${JSON.stringify(out, null, 2)}\n`;
}

const regions = [
  { file: "desktop/src/lib/models.ts", id: "models", render: desktopModels },
  { file: "desktop/src/lib/models.ts", id: "labels", render: desktopLabels },
  {
    file: "ios/ArchcarKit/Sources/ArchcarKit/Stores/AgentModels.swift",
    id: "models",
    render: swiftModels,
  },
  {
    file: "ios/ArchcarKit/Sources/ArchcarKit/Stores/AgentModels.swift",
    id: "labels",
    render: swiftLabels,
  },
  { file: "crates/core/src/model_registry.rs", id: "models", render: rustRegistry },
  { file: "crates/core/src/notifications.rs", id: "labels", render: rustLabels },
];

/** Replace the text between this region's markers, keeping the marker lines. */
function replaceRegion(text, file, id, body) {
  const begin = new RegExp(`^([^\\n]*)${MARK_BEGIN} \\(${id}\\)[^\\n]*$`, "m");
  const end = new RegExp(`^[^\\n]*${MARK_END} \\(${id}\\)[^\\n]*$`, "m");
  const beginMatch = begin.exec(text);
  const endMatch = end.exec(text);
  if (!beginMatch || !endMatch) {
    console.error(
      `${file}: missing the "${id}" generated-region markers. Add them around the block this script owns.`,
    );
    process.exit(1);
  }
  const from = beginMatch.index + beginMatch[0].length;
  const to = endMatch.index;
  return `${text.slice(0, from)}\n${body}\n${text.slice(to)}`;
}

const updates = new Map();
for (const region of regions) {
  const path = join(repoRoot, region.file);
  const current = updates.get(region.file) ?? readFileSync(path, "utf8");
  updates.set(region.file, replaceRegion(current, region.file, region.id, region.render()));
}

const fixtureFile = "crates/core/tests/fixtures/model_labels.json";
updates.set(fixtureFile, labelFixture(readFileSync(join(repoRoot, fixtureFile), "utf8")));

const drifted = [];
for (const [file, next] of updates) {
  const path = join(repoRoot, file);
  const current = readFileSync(path, "utf8");
  if (current === next) continue;
  if (check) {
    drifted.push(file);
    continue;
  }
  writeFileSync(path, next);
  console.log(`updated ${file}`);
}

if (check && drifted.length > 0) {
  console.error(
    `These mirrors no longer match model-corpus.json:\n${drifted.map((f) => `  ${f}`).join("\n")}\n` +
      "Run: node scripts/generate-model-corpus.mjs",
  );
  process.exit(1);
}

console.log(
  check
    ? `model corpus is in sync (${allModels.length} models across ${providerNames.length} providers)`
    : `model corpus written (${allModels.length} models across ${providerNames.length} providers)`,
);
