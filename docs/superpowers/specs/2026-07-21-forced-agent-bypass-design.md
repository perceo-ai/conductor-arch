# Forced Agent Bypass Launch Policy Design

## Goal

Ensure every Codex and Claude session started or resumed by Archductor runs
without approval prompts. This is a product invariant, not a configurable
default: Shared, repository, Local, CLI, GTK, persisted metadata, and provider
resume state must not weaken it.

Use bare provider startup where the installed provider and launch mode support
it, without breaking providers or stream protocols that do not expose a bare
mode.

## Chosen Approach

Normalize permissions at the central provider launch-contract boundary. All
callers may continue to parse older approval inputs for compatibility, but the
effective launch plan and persisted effective metadata always use bypass mode.

This covers GTK, CLI, Archcar, new sessions, resumed sessions, Codex app-server,
Claude stream-json, and future call sites that use the shared launch contract.
It avoids relying on user configuration or duplicating forced flags at each UI
boundary.

## Provider Contract

### Codex

Interactive/TUI Codex launch plans always include
`--dangerously-bypass-approvals-and-sandbox`. Archductor must not also emit a
conflicting `--ask-for-approval` or restricted `--sandbox` argument.

Codex app-server thread and turn startup always send approval policy `never`
and sandbox policy `danger-full-access`. New and resumed threads receive the
same values.

Effective harness/session metadata records `approval=never` so diagnostics,
history, and GTK controls describe actual runtime behavior.

### Claude

Claude launch plans always request `bypassPermissions`. Where the CLI contract
supports both spellings, Archductor includes the explicit
`--permission-mode bypassPermissions` and `--dangerously-skip-permissions`
arguments. No prompt-capable permission mode may survive normalization.

Claude stream-json connection state and resumed sessions retain
`bypassPermissions`. Effective harness/session metadata records
`approval=never`.

## Bare Startup

`--bare` is conditional capability, independent of mandatory bypass behavior.
Archductor adds it only when both conditions hold:

1. The selected provider launch mode can operate correctly without loading the
   settings, hooks, plugins, or other initialization that bare mode suppresses.
2. The installed provider reports support for the argument through its local
   help/capability probe or an equivalent versioned descriptor.

The capability result is cached with other provider readiness data so launch
planning does not repeatedly spawn help processes. Unsupported, unknown, or
unavailable providers omit `--bare` and continue in mandatory bypass mode.

Claude stream-json currently has tests explicitly excluding `--bare`, and
Anthropic's current public CLI reference does not document that flag. It stays
excluded until a locally installed Claude binary reports support and the
stream-json adapter's compatibility tests prove the mode works. Codex receives
`--bare` only if a Codex launch mode actually exposes it; the currently
installed Codex CLI does not list it.

## Configuration and UI

Approval configuration remains parseable so old settings files and automation
do not fail to load. It no longer affects the effective launch policy for
Codex or Claude.

GTK displays the effective permission mode as enforced bypass. Prompt-capable
choices are removed or insensitive, and explanatory text makes clear that
Archductor-owned agents run without approval prompts.

CLI arguments remain accepted for compatibility. Session-plan/status output
reports the effective forced bypass value rather than echoing an ignored input.
If a user explicitly supplies a conflicting value, the CLI may emit a concise
notice, but it must not fail or launch with prompts.

## Persistence and Resume

Archductor rewrites effective launch metadata to `approval=never` before it is
persisted. Existing session records containing `ask`, `on-request`, `default`,
or no approval value are normalized when resumed; stale metadata cannot restore
approval prompts.

Provider-native resume identifiers, models, reasoning settings, and thread
history remain unchanged. Only permission/sandbox policy and supported bare
startup behavior are normalized.

## Failure Behavior

If a provider rejects its documented bypass option, session startup fails with
a visible provider launch error. Archductor must not silently retry in a
prompt-capable mode.

A failed or unavailable bare-capability probe is non-fatal: omit `--bare` and
start with bypass. The diagnostic state records why bare mode was not used.

## Testing and Verification

Written core tests cover:

- Codex TUI launch arguments always force bypass and remove conflicts;
- Codex app-server new and resumed thread/turn requests use `never` plus
  `danger-full-access`;
- Claude new and resumed stream-json launches use `bypassPermissions` and the
  explicit skip-permissions flag;
- caller/settings values such as `ask`, `on-request`, and missing values all
  normalize to bypass;
- persisted and resumed metadata records `approval=never`;
- `--bare` appears only for a positively detected compatible capability; and
- failed/unknown probes omit `--bare` without weakening bypass.

CLI tests prove conflicting approval inputs are accepted but the emitted launch
plan remains bypass. GTK tests prove prompt-capable choices are absent and the
effective mode is visibly enforced.

CLI smoke starts or inspects Codex and Claude session plans through the command
boundary. GTK smoke starts Codex and, where an authenticated Claude installation
exists, Claude, confirming no approval prompt appears. Live Claude verification
is reported incomplete when the binary/authentication is unavailable.

## Scope Boundaries

This change does not bypass operating-system authentication, provider login,
network credentials, GitHub/Linear authorization, or destructive-action
confirmations owned by Archductor itself. It only controls Codex and Claude
tool-execution approval/sandbox prompts inside provider sessions.
