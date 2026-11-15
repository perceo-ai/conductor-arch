#!/usr/bin/env bash
set -euo pipefail

# The model corpus is mirrored into the desktop app, iOS, two Rust files and a
# shared label fixture. Hand-editing five places is what let the list rot into
# ids the provider CLIs no longer accept, so one JSON file is the source and
# `scripts/generate-model-corpus.mjs` writes the rest. These tests pin the two
# properties that keep it honest: the mirrors match the source, and a retired
# id cannot be shipped as selectable.

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
script="$repo_root/scripts/generate-model-corpus.mjs"
corpus="$repo_root/model-corpus.json"

fail() {
    echo "FAIL: $*" >&2
    exit 1
}

work_dir="$(mktemp -d)"
trap 'rm -rf "$work_dir"' EXIT

[ -x "$script" ] || fail "generator missing or not executable: scripts/generate-model-corpus.mjs"
[ -s "$corpus" ] || fail "model corpus missing or empty: model-corpus.json"

# A copy of only the files the generator touches, so a test can tamper with a
# mirror without writing in the real tree.
make_sandbox() {
    local dir="$1"
    mkdir -p "$dir"
    (cd "$repo_root" && tar -cf - \
        model-corpus.json \
        scripts/generate-model-corpus.mjs \
        desktop/src/lib/models.ts \
        ios/ArchcarKit/Sources/ArchcarKit/Stores/AgentModels.swift \
        crates/core/src/model_registry.rs \
        crates/core/src/notifications.rs \
        crates/core/tests/fixtures/model_labels.json) | (cd "$dir" && tar -xf -)
}

# 1. The committed mirrors match the committed corpus.
node "$script" --check >"$work_dir/check.log" 2>&1 ||
    fail "committed mirrors drifted from model-corpus.json; run scripts/generate-model-corpus.mjs. Output: $(cat "$work_dir/check.log")"

# 2. Drift inside a generated region is caught, and the failure names the file.
#    Text outside the markers is hand-maintained and deliberately left alone.
drift_dir="$work_dir/drift"
make_sandbox "$drift_dir"
perl -0pi -e 's/"gpt-6\.1-sol"/"gpt-hand-edited"/' "$drift_dir/desktop/src/lib/models.ts"
if node "$script" --check --repo "$drift_dir" >"$work_dir/drift.log" 2>&1; then
    fail "--check passed with a drifted desktop mirror"
fi
grep -q "desktop/src/lib/models.ts" "$work_dir/drift.log" ||
    fail "drift report does not name the file that drifted: $(cat "$work_dir/drift.log")"

# 3. Regenerating repairs that drift.
node "$script" --repo "$drift_dir" >"$work_dir/write.log" 2>&1 ||
    fail "generator failed on a drifted tree: $(cat "$work_dir/write.log")"
node "$script" --check --repo "$drift_dir" >"$work_dir/recheck.log" 2>&1 ||
    fail "--check still fails after regenerating: $(cat "$work_dir/recheck.log")"

# 4. A selectable id that the corpus also lists as retired is refused. This is
#    the whole point of the retired list: shipping one means every chat started
#    on it dies at the provider.
retired_dir="$work_dir/retired"
make_sandbox "$retired_dir"
node -e '
const fs = require("fs");
const path = process.argv[1];
const corpus = JSON.parse(fs.readFileSync(path, "utf8"));
const id = corpus.providers.codex.models[0].id;
corpus.retired = [...(corpus.retired ?? []), { id, retired_on: "2026-01-01", note: "test" }];
fs.writeFileSync(path, JSON.stringify(corpus, null, 2) + "\n");
' "$retired_dir/model-corpus.json"
if node "$script" --check --repo "$retired_dir" >"$work_dir/retired.log" 2>&1; then
    fail "a model listed as retired was accepted as selectable"
fi
grep -qi "retired" "$work_dir/retired.log" ||
    fail "refusal does not explain that the model is retired: $(cat "$work_dir/retired.log")"

# 5. Staleness is reported on its own, so the weekly run can nag without a diff.
#    Neither provider CLI enumerates its models, so "someone re-read the docs
#    recently" is the only freshness signal there is.
stale_dir="$work_dir/stale"
make_sandbox "$stale_dir"
node -e '
const fs = require("fs");
const path = process.argv[1];
const corpus = JSON.parse(fs.readFileSync(path, "utf8"));
corpus.checked_on = "2020-01-01";
fs.writeFileSync(path, JSON.stringify(corpus, null, 2) + "\n");
' "$stale_dir/model-corpus.json"
if node "$script" --check --max-age 60 --repo "$stale_dir" >"$work_dir/stale.log" 2>&1; then
    fail "a corpus last checked in 2020 passed --max-age 60"
fi
grep -q "checked against the vendors" "$work_dir/stale.log" ||
    fail "staleness failure does not say the corpus is overdue: $(cat "$work_dir/stale.log")"

# A corpus checked today is not stale.
fresh_dir="$work_dir/fresh"
make_sandbox "$fresh_dir"
node -e '
const fs = require("fs");
const path = process.argv[1];
const corpus = JSON.parse(fs.readFileSync(path, "utf8"));
corpus.checked_on = new Date().toISOString().slice(0, 10);
fs.writeFileSync(path, JSON.stringify(corpus, null, 2) + "\n");
' "$fresh_dir/model-corpus.json"
node "$script" --repo "$fresh_dir" >/dev/null 2>&1
node "$script" --check --max-age 60 --repo "$fresh_dir" >"$work_dir/fresh.log" 2>&1 ||
    fail "a corpus checked today failed --max-age 60: $(cat "$work_dir/fresh.log")"

# 6. The generated desktop mirror really carries the corpus ids.
first_codex="$(node -e '
const fs = require("fs");
const corpus = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
process.stdout.write(corpus.providers.codex.models[0].id);
' "$corpus")"
grep -q "\"$first_codex\"" "$repo_root/desktop/src/lib/models.ts" ||
    fail "desktop mirror is missing the corpus's first codex model ($first_codex)"
grep -q "\"$first_codex\"" "$repo_root/ios/ArchcarKit/Sources/ArchcarKit/Stores/AgentModels.swift" ||
    fail "iOS mirror is missing the corpus's first codex model ($first_codex)"
grep -q "\"$first_codex\"" "$repo_root/crates/core/src/model_registry.rs" ||
    fail "Rust mirror is missing the corpus's first codex model ($first_codex)"
grep -q "\"$first_codex\"" "$repo_root/crates/core/tests/fixtures/model_labels.json" ||
    fail "label fixture is missing the corpus's first codex model ($first_codex)"

echo "PASS: model corpus generator"
