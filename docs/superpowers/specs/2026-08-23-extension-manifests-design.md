# Extension Manifests Design

Date: 2026-08-23
Status: Approved design, not yet implemented
Spec 2 of 3. Independent of spec 1 (`modular-layout`) and spec 3
(`desktop-streaming-and-operator-agent`); can be built in parallel.

## Problem

Two kinds of extension point are hardcoded, and they are hardcoded in
different ways.

**Task sources** barely exist as a concept. `crates/core/src/linear.rs` is 161
lines exposing exactly one function — `fetch_linear_issue(id) -> {title,
description}`. GitHub issue and PR sources are `gh` shell-outs wired directly
into `crates/core/src/workspace.rs`. There is no listing, no write-back, no
shared abstraction. Adding a third source means another bespoke module and
another set of edits to a 20,000-line file.

Notably, the Linear status workflow this repository actually follows — move to
`In Progress` on start, `In Review` on finish — is not implemented by the app
at all. It is done by the *agent* calling the Linear MCP server, which means it
happens when the agent remembers to do it.

**Agents and models** are in better shape. `crates/core/src/agent_tools.rs`
holds a static `TOOL_SPECS` array of twelve agents, three chat-launchable
(codex, claude, gemini). `provider_adapters/acp.rs` is already a generic
adapter: gemini is launchable purely because its row carries
`acp_args = ["--experimental-acp"]`, with no bespoke parsing. `claude_stream.rs`
and `codex_app_server.rs` are hand-written because those agents do not speak
ACP. Meanwhile `crates/core/src/model_registry.rs` is 31 lines of hardcoded
string constants — adding a model id requires a recompile.

So the ACP path is nearly free already and the model list is needlessly frozen.

## Goals

- A user adds a task source by dropping a manifest file in, with no compile.
- A task source can resolve one item, list many, transition an item's state,
  and comment on it.
- The app performs status transitions deterministically at lifecycle points,
  instead of relying on an agent to remember.
- A user adds an ACP-speaking agent, or new models for an existing agent, by
  manifest.
- A dropped-in manifest cannot run until the user has seen what it would run.

## Non-goals

- **Repository-provided manifests.** Out of scope entirely. A manifest in a
  repo would make `git clone` equivalent to arbitrary code execution, which is
  a materially worse position than today.
- **Extension-contributed UI.** Sources render through generic built-in
  surfaces. See spec 1.
- **Subscribe/polling.** No background fetch of newly-assigned work, no
  auto-spawned workspaces. This turns the app from something you open into
  something that runs unattended, and deserves its own spec.
- **Non-ACP agents by manifest.** A declarative parser DSL would handle 70% of
  an agent and then need an escape hatch. Non-ACP agents keep needing a Rust
  adapter plus a registry row.
- **Raw API providers.** Building a harness — prompt construction, streaming,
  tool loop, permissions — is building a coding agent, not integrating one.
- **An HTTP-only capability tier.** The schema reserves room for it (see
  *Reserved: the HTTP tier*), but shell is the only executor built now.

## Trust model

This is the part that can hurt, so it is specified before the features.

A manifest declaring `command = [...]` is arbitrary code execution with the
daemon's privileges, on the machine holding the repositories, the `gh` token,
and `LINEAR_API_KEY`. Two properties make it sharper than the existing
setup/run scripts: a task source runs on a schedule to populate a list rather
than when a user presses Run, and manifests execute on the *daemon* host, so
under a remote profile whoever holds the archcar token gets that execution.

Rules:

1. **One location.** `~/.archductor/extensions/<id>/extension.toml`. Nothing
   else is scanned. Not the repo, not the workspace, not the project settings.
2. **Inert until enabled.** A newly discovered manifest is parsed, validated,
   and listed as `disabled`. It executes nothing — not even a readiness probe —
   until the user enables it.
3. **Informed consent.** The enable dialog renders every command the manifest
   can run, verbatim, with placeholders shown unsubstituted, plus the
   environment variables it reads and the hosts it names.
4. **Hash pinning.** The daemon stores a SHA-256 of the manifest bytes at
   enable time. If the file changes, the extension reverts to `disabled`
   pending re-approval, and the app says so. This is what stops "enable a
   harmless manifest, then rewrite it."
5. **No shadowing.** An extension may not claim a `provider_key` or source id
   that a built-in already owns. Load fails with a clear error rather than
   silently overriding `claude` with something else.
6. **Bounded execution.** Every command runs with a timeout (default 20s,
   manifest may lower, may not raise past 120s), a stdout cap (1 MiB), no stdin,
   and its working directory set to a scratch dir — never a workspace tree.
   Output passes through `crates/core/src/redaction.rs` before it reaches logs.
7. **Environment allowlist.** A manifest declares which env vars it needs; only
   those are passed through, plus `PATH`, `HOME`, and locale. The daemon's full
   environment is not inherited.

Enable state lives in a daemon table, not in settings TOML, so it cannot be set
by editing a file that something else writes:

```sql
CREATE TABLE extensions (
  id           TEXT PRIMARY KEY,
  kind         TEXT NOT NULL,          -- task_source | agent | models
  manifest_sha TEXT NOT NULL,
  enabled      INTEGER NOT NULL DEFAULT 0,
  enabled_at   INTEGER,
  last_error   TEXT
);
```

### Reserved: the HTTP tier

The manifest schema keeps `command` under an explicit executor table so a
second executor can be added without a breaking change:

```toml
[source.list.exec]
kind = "shell"                # only value implemented now
command = ["gh", "issue", "list", "--json", "number,title,url,state"]
```

A future `kind = "http"` with declared hosts, method, headers, and body would
be non-executing by construction and could relax rules 2 through 4. Designing
the field now costs nothing; implementing it now costs a second executor with
no user asking for it.

## Manifest format

TOML, matching the existing settings convention.

### Task source

```toml
[extension]
id = "linear"
kind = "task_source"
label = "Linear"
schema_version = 1

[extension.env]
required = ["LINEAR_API_KEY"]

[source]
# Optional: an item's URL pattern, used for opening in a browser.
item_url = "https://linear.app/issue/{{id}}"

[source.list.exec]
kind = "shell"
command = ["curl", "-sS", "-XPOST", "https://api.linear.app/graphql",
           "-H", "Authorization: $LINEAR_API_KEY",
           "-H", "Content-Type: application/json",
           "-d", "{\"query\":\"{ issues(filter:{assignee:{isMe:{eq:true}}}) { nodes { identifier title url state { name } assignee { name } } } }\"}"]

[source.list.map]
items    = "data.issues.nodes[]"
id       = "identifier"
title    = "title"
url      = "url"
state    = "state.name"
assignee = "assignee.name"

[source.resolve.exec]
kind = "shell"
command = ["curl", "-sS", "...{{id}}..."]

[source.resolve.map]
id    = "data.issue.identifier"
title = "data.issue.title"
body  = "data.issue.description"
url   = "data.issue.url"
state = "data.issue.state.name"

[source.transition.exec]
kind = "shell"
command = ["curl", "-sS", "...{{id}}...{{state}}..."]

[source.transition.states]
start  = "In Progress"
review = "In Review"
done   = "Done"

[source.comment.exec]
kind = "shell"
command = ["curl", "-sS", "...{{id}}...{{body}}..."]
```

**Placeholders.** `{{id}}`, `{{query}}`, `{{state}}`, `{{body}}` substitute into
argv *elements*, never into a shell string — there is no shell interpretation,
arguments are passed to `exec` directly. `$VAR` in an argv element expands only
from the declared env allowlist. This means an item title containing
`; rm -rf /` is inert, because it is one argv element and no shell parses it.

**Mapping.** A deliberately small path language, not JSONPath and not jq —
adding a jq dependency to ship four field lookups is not worth it:

- Dotted segments descend objects: `data.issue.title`
- `[]` on `items` marks the array to iterate
- A missing path yields null; a missing *required* field (`id`, `title`) drops
  that item and logs once with a count

If a command already emits the canonical shape, `map` may be omitted.

Canonical work item, as core sees it:

```rust
pub struct WorkItem {
    pub source_id: String,
    pub id: String,          // required
    pub title: String,       // required
    pub url: Option<String>,
    pub state: Option<String>,
    pub assignee: Option<String>,
    pub body: Option<String>,
}
```

Every source produces this. That uniformity is what makes generic built-in
surfaces sufficient, and therefore what makes "no extension UI" a viable
decision rather than a limitation.

### Agent

```toml
[extension]
id = "some-acp-agent"
kind = "agent"
schema_version = 1

[agent]
provider_key    = "someagent"
display_name    = "Some Agent"
default_command = "someagent"
aliases         = ["someagent", "some-agent"]
acp_args        = ["--acp"]            # required and non-empty
readiness_probe = ["someagent", "--version"]
auth_guidance   = "Run `someagent login`."
models          = ["some-model-a", "some-model-b"]
default_model   = "some-model-a"
```

`acp_args` must be non-empty. An agent manifest without it is rejected at
validation with an error naming the non-goal: agents that do not speak ACP need
a Rust adapter. This is the single rule that keeps this feature from becoming a
parser DSL by accident.

### Models

```toml
[extension]
id = "extra-claude-models"
kind = "models"
schema_version = 1

[models]
provider = "claude"
add = ["claude-something-new"]
```

Extends an existing provider's list. Cannot remove built-in models — removal
would silently break saved threads that reference them.

## Core changes

New module `crates/core/src/extensions/` with `manifest.rs` (parse and
validate), `store.rs` (the table, enable/disable, hash checks), `exec.rs`
(templating, spawn, timeout, caps, redaction), `map.rs` (the path language),
and `task_source.rs` (the four operations over a loaded manifest).

**Registry becomes static + dynamic.** `agent_tools::agent_tools()` returns
built-in `TOOL_SPECS` chained with enabled agent manifests. `ToolSpec`'s
`&'static str` fields force a choice here: either leak manifest strings or
convert `ToolSpec` to owned `String`. Owned is correct — the static-lifetime
assumption is precisely what makes the registry closed — and it is a mechanical
change across `agent_tools.rs`, `doctor.rs`, and `session_kind.rs`.
`AgentProviderSummary` gains `source: "builtin" | "extension"` so the UI can
badge extension-backed agents.

`model_registry::model_choices_for_provider` reads built-ins plus enabled
`models` manifests, and gains an owned return type for the same reason.

**Transitions get called by the app.** Two lifecycle hooks in
`workspace.rs`, which is where the deterministic behaviour this feature is
actually for gets delivered:

- Workspace created from a work item → `transition(id, "start")`
- Pull request created for that workspace → `transition(id, "review")`

`done` is exposed as a manual action, not wired to merge — merge is not always
the end of a ticket, and guessing wrong writes to someone else's tracker.

The workspace-to-item link needs persisting. Workspaces already record their
source; this adds `source_extension_id` and `source_item_id` columns so a
transition can be issued later without re-deriving the item from the branch
name.

Transition failures are non-fatal and surface as a toast plus a timeline entry.
A tracker being down must not block creating a workspace.

## Protocol

- `list_extensions` → `{ extensions: [{id, kind, label, enabled, source_path, manifest_sha, last_error, commands: [...]}] }`
- `enable_extension { id, manifest_sha }` → `ok` — the client echoes the hash it
  displayed; a mismatch means the file changed between review and click, and
  the request is rejected
- `disable_extension { id }` → `ok`
- `reload_extensions` → rescan the directory
- `list_work_items { source_id, query? }` → `{ items: WorkItem[] }`
- `resolve_work_item { source_id, item_id }` → `{ item: WorkItem }`
- `transition_work_item { source_id, item_id, state }` → `ok`
- `comment_work_item { source_id, item_id, body }` → `ok`

## Desktop UI

**Settings → Extensions.** One row per discovered manifest: label, kind,
enabled toggle, source path, and any load error. Enabling opens a review dialog
listing every command verbatim, the env vars read, and the hosts named, with
the enable button below. A hash mismatch renders as "This extension changed
since you approved it" with the commands re-shown.

**New workspace dialog.** The source picker is generated from enabled
`task_source` extensions alongside the built-in branch/prompt/GitHub paths.
Selecting one calls `list_work_items` and renders the canonical fields as a
searchable list; picking an item seeds workspace name and prompt from
`title`/`body`.

**Tasks panel.** Where a workspace has a linked work item, show its current
state, a link out, and manual transition/comment actions.

Both surfaces are generic over `WorkItem`, which is what discharges the
"no extension UI" decision.

## CLI parity

- `archductor extensions list|show <id>|enable <id>|disable <id>|reload`
- `archductor work-items list --source <id> [--query <q>]`
- `archductor work-items show --source <id> --item <item-id>`
- `archductor work-items transition --source <id> --item <item-id> --state start|review|done`

`enable` prints the same command list and requires `--yes` to proceed, so the
consent gate exists on both surfaces rather than being a GUI-only nicety.

## Error handling

- **Invalid manifest** — listed with `last_error`, never enabled, never run.
  One bad file does not prevent others loading.
- **Missing required env** — surfaces as a readiness failure on the extension
  row, with the variable named. Commands are not attempted.
- **Command timeout / non-zero exit / oversized output** — operation fails with
  the exit code and truncated, redacted stderr. `list` failing shows an error in
  the picker; `transition` failing toasts and logs to the timeline.
- **Unparseable output** — reports the first mapping path that failed, which is
  the difference between a debuggable manifest and a mysterious one.
- **Shadowed id** — load error naming the conflict.
- **Hash mismatch on enable** — rejected; client must re-read and re-display.

## Testing

Rust unit:

- Manifest parse: valid task source, valid agent, valid models, and each
  rejection — empty `acp_args`, shadowed key, unknown kind, bad schema version.
- Templating: placeholder substitution into argv elements; an item title
  containing shell metacharacters stays a single inert argument; `$VAR` expands
  only from the allowlist; undeclared vars do not leak.
- Mapping: nested paths, array iteration, missing optional yields null, missing
  required drops the item.
- Exec: timeout kills the child, stdout cap truncates, non-zero exit reports,
  redaction applied.
- Store: enable requires matching hash; mutating the file flips to disabled;
  disabled extensions are absent from the registry and cannot be invoked.
- Registry merge: an enabled agent manifest appears in
  `agent_provider_summaries()` with `source: "extension"`; a disabled one does
  not; built-ins are unaffected.

Fixtures use a hermetic fake source built from `echo` emitting canned JSON — no
network, no credentials, runs in CI.

CLI smoke: install the fake source into a temp `HOME`, `extensions list` shows
it disabled, `work-items list` refuses, `extensions enable --yes`,
`work-items list` returns the canned items, mutate the file, confirm the next
call reports the hash mismatch.

Desktop: Vitest over the review-dialog command rendering and the picker's
`WorkItem` list; Playwright smoke enabling the fake source and creating a
workspace from an item.

## Increments

1. **Manifest + store + consent, no operations.** Discovery, validation, the
   table, enable/disable with hash pinning, Settings UI, CLI. Nothing executes
   yet — the security model lands before anything can run.
2. **Exec + mapping + `list`/`resolve`.** Task sources become readable; the new
   workspace picker works.
3. **`transition`/`comment` + lifecycle hooks.** The deterministic status
   updates this feature is actually for.
4. **Agent + models manifests.** Including the `ToolSpec` owned-string
   conversion.

Step 1 first is deliberate: shipping execution before the gate means the gate
gets retrofitted onto something already running.

## Risks

- **`ToolSpec` owned-string conversion** touches `agent_tools.rs`,
  `doctor.rs`, `session_kind.rs`, and their tests. Mechanical, but wide, and
  it is the kind of change that is annoying to review mixed with feature work.
  Land it as its own commit.
- **The mapping language will be insufficient.** Some API will need a filter, a
  join, or a conditional. The intended answer is that the manifest shells out
  to something that reshapes the JSON — the exec layer already permits it —
  not that the path language grows. Say no to the second feature request here.
- **Credentials in manifests.** The env allowlist is the sanctioned path, but
  nothing stops a user pasting a token into a `command` array. The review
  dialog will render it, which is at least visible; the docs should say plainly
  that manifests are not a place for secrets.
- **A source that is slow** makes the new-workspace dialog feel broken. `list`
  needs a spinner and a cancel, and results should cache briefly.
- **`gh`-based sources inherit `gh`'s auth**, which means an extension can act
  as the user on GitHub. That is the intended power of the shell tier, and the
  reason the consent gate shows the command.
