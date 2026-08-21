# Multi-Repo Projects — Design and Scope

Status: **not started**. This is the measured shape of the work, written after
the skill library landed, so the next session can start on code rather than on
archaeology.

## Why it is not a normal feature

`1 project contains 1 repository` is not a convention here, it is the schema.
Measured on 2026-08-20:

- **218** references to `repository_id` across 7 files.
- `crates/core/src/workspace.rs` is **25,801** lines and assumes one checkout
  per workspace throughout: `workspace.path`, `workspace.branch`,
  `workspace.base_ref` are singular fields, and every git call takes
  `&workspace.path`.
- `progress.md` records the original decision: "the product model stays one
  repository per project."

Conductor shipped multiple git repos in 0.25.6 (Dec 2025), so this is real
parity, not a nice-to-have. But a half-migrated schema on a shared branch is
worse than no migration, which is why this is a design rather than a partial
implementation.

## The decision that shapes everything

**Does a workspace span repositories, or does a project merely group them?**

- **A. Project groups repositories.** A workspace still belongs to exactly one
  repository; the project is a folder in the sidebar. Cheap — mostly UI and a
  `projects` table with a foreign key. Does not let one task change two repos,
  which is the actual use case people want.
- **B. A workspace spans repositories.** One task, N worktrees, one branch name
  across them, diffs and checks aggregated. Expensive, and it is what
  "multi-repo" means to someone with a split frontend/backend.

Recommendation: **B**, staged so A falls out of the first stage. Building A and
stopping produces a sidebar reorganisation that nobody asked for.

## Staging

1. **Introduce `projects`.** New table; every existing repository becomes a
   single-repository project, preserving ids. `repository_id` on workspaces
   stays. Nothing user-visible changes; this is the migration that must be
   boring and reversible.
2. **`workspace_repositories`.** A workspace gains a set of checkouts, seeded
   with the one it already has. `workspace.path` becomes the *primary*
   checkout so existing call sites keep working while new code reads the set.
3. **Fan out git.** Diff, changed files, commits, checks, and branch state
   aggregate across the set. This is where the 218 references get visited; most
   become "for each checkout".
4. **Creation and UI.** New workspace picks which repositories participate;
   the Changes panel groups by repository; the PR flow opens one PR per repo
   with a shared body.

Stages 1 and 2 are independently shippable and invisible. Stage 3 is the bulk.
Stage 4 is where it becomes a feature.

## Traps found while measuring

- `workspace_merge_base_ref` and `diff_stats_against_base` assume one base;
  with N repos "behind base" is per-repo and the roll-up needs a rule.
- The PR flow records exactly one `pull_requests` row per workspace
  (`ON CONFLICT(workspace_id)`), so stage 4 needs that unique constraint
  relaxed before it can open two.
- Checkpoints snapshot one worktree; they need to become per-repo or explicitly
  refuse on multi-repo workspaces rather than silently capturing one of them.
- The remote-client work assumed `workspace.path` is a single daemon-side
  directory; the client-filesystem guards added in this branch stay correct,
  but anything showing "the workspace folder" needs to ask "which one".

## What to do first

Stage 1 with its migration test, on a branch of its own, with `progress.md`'s
"one repository per project" line updated in the same commit so the stated
model and the schema never disagree.
