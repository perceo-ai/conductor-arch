---
title: "Archductor UX and Backend Strategy"
strategy_date: "2026-08-12"
last_reviewed: "2026-08-12"
status: "working strategy"
related_docs:
  - "docs/2026-08-12-perceo-suite-ux-strategy.md"
  - "docs/repo-summaries/2026-08-12-conductor-arch-summary.md"
---

# Archductor UX and Backend Strategy - 2026-08-12

## Purpose

This document defines the emerging Archductor direction after clarifying its role in the Perceo suite.

Archductor should be a Conductor-like workspace launcher and agentic development environment. It is the carrier layer for future Perceo workflows: it should preserve the proven Conductor interaction model while adding daemon/API/CLI/MCP reach, background execution, lightweight coordination, and optional Archivum context.

It should not become the broad memory product, a general automation dashboard, or a full embedded Archivum clone.

## Core Thesis

Archductor should feel exactly like Conductor where that matters:

- Workspaces on the left.
- Agent chats and files in the center.
- Workspace intelligence and controls on the right.
- Terminals/checks/logs docked in the lower part of the right panel.
- Branch/worktree-oriented development.
- Many concurrent coding agents.
- Diffs, checks, review, and PR handoff.

The difference is reach:

- Local or server daemon owns workspaces and sessions.
- Web/native UI is a client.
- CLI, API, and MCP can drive the same primitives.
- Background tasks can create workspaces, run agents, prepare reviews, and open PRs.
- Archivum can provide context when enabled.

The intended product feeling is:

**Conductor feel, Archductor reach.**

## Product Role

Archductor is the active development environment for coding agents.

Archivum owns durable human and agent memory. archfleet owns computer-use execution and semantic tests. Archductor owns:

- Branch workspaces.
- Agent sessions.
- Development tasks.
- Local operational summaries.
- Terminals and command/check output.
- Files and diffs.
- Review and PR preparation.
- Background coding work.
- API/CLI/MCP access to development primitives.

It is mostly a carrier for the future suite. It should stay focused and familiar while making room for Archivum and archfleet integrations.

## Non-Goals

Initial mature Archductor should explicitly avoid:

- Durable long-term memory. Archivum owns that.
- A general automation dashboard. Archductor is for development work.
- A full Archivum clone embedded in the app.
- A graph administration interface.
- A broad personal knowledge base.
- A generic chat assistant unrelated to active coding work.
- A workflow engine for arbitrary non-code tasks.

Archductor can expose hooks into these systems, but it should not absorb them.

## Core Object Model

### Workspace

A workspace is a branch.

Every workspace maps to an isolated development branch/worktree-like environment. This is the primary unit in the UI and backend.

A workspace contains:

- Branch metadata.
- One or more repos when needed, but usually one.
- Many agent sessions.
- Tasks.
- Files and open editors.
- Terminals.
- Command/check history.
- Per-session summaries.
- Workspace summary.
- Per-agent diffs.
- Aggregate branch diff.
- Review state.
- PR state.

### Task

A workspace can have many tasks.

Tasks organize intent inside the branch. They are not the root object. They help coordinate many agents working in one branch without turning the product into enterprise project management.

Task fields should include:

- Title.
- Description/prompt.
- Status.
- Owner agent or human.
- Related files/areas.
- Linked sessions.
- Blockers.
- Review notes.

### Agent Session

An agent session is a running, paused, failed, complete, closed, or archived coding conversation attached to one workspace.

Each session should record:

- Harness/runtime.
- Model.
- Prompt/task association.
- Current status.
- Files touched.
- Intended files/areas.
- Commands run.
- Checks/tests run.
- Diff contribution.
- Summary.
- Handoff notes.
- Risks/blockers.
- Whether its changes are still present in the branch.

### Summary

Archductor should maintain operational summaries, not durable memory.

Summary types:

- Per-session summary.
- Workspace/branch summary.
- Task summary.
- Handoff summary.
- Review summary.

Summaries should be useful for continuation and review:

- Goal.
- Files touched.
- Decisions made in this branch.
- Commands/checks run.
- Current blockers.
- Risks.
- Next suggested actions.

If Archivum is enabled, important summaries or learnings can be submitted to Archivum as review candidates. Archductor should not silently create durable memory.

## UX Layout

Archductor should preserve Conductor muscle memory.

### Left Rail

The left rail is the workspace/branch list.

It should show:

- Workspace name.
- Branch.
- Repo.
- Status.
- Active agent count.
- Blocked/needs-review indicators.
- PR state.
- Recent activity.

The left rail should make it easy to jump between active branches and archived/closed workspaces.

### Center

The center is where work happens.

It should show:

- Agent chats.
- Files open in the workspace.
- Agent session tabs or list.
- Prompt composer.
- File context around the current session.

This should feel very close to Conductor: a human can watch and prompt coding agents directly.

### Right Panel

The right panel contains workspace intelligence and controls.

Use tabs above a terminal/log dock:

- Tasks
- Summary
- Files
- Changes
- Checks
- Context
- Review
- PR

The terminal/check/log area should be docked at the bottom of the right panel with a draggable split. This preserves the desired layout while keeping terminal output usable.

Avoid accordion-heavy right panels. The right panel will become dense quickly; tabs with clear surfaces are safer.

### Bottom-Right Terminal Dock

The bottom half of the right panel should provide terminal/log/check output.

It should support:

- Workspace terminal.
- Per-agent terminal/log stream.
- Check/test output.
- Command history.
- Running command state.
- Failure details.

The terminal dock should be resizable because right-panel density is high.

## Context UX

Archductor has two context modes: standalone and Archivum-enabled.

### Standalone Context

When Archivum is not enabled, Archductor should provide lightweight local operational context.

This includes:

- Workspace summary.
- Session summaries.
- Pinned notes.
- Pinned files.
- Important files.
- Task list.
- Recent branch-local decisions.
- Commands/checks history.
- Handoff notes.

This should not be marketed or modeled as durable long-term memory. It is branch-local continuity.

### Archivum-Enabled Context

When Archivum is enabled, Archductor should add a focused Context tab.

The Context tab should show:

- Current Archivum context pack.
- Loaded human/project/repo/topic memory.
- Source citations.
- Scope controls.
- Retrieve more from Archivum.
- Submit session/workspace summary to Archivum review.
- Open in Archivum.

Do not embed the full Archivum review or memory-management UI. Archductor only needs the context relevant to the current branch/workspace.

## Coordination Model

Archductor should use a lightweight coordination layer.

It should show:

- Who is working on what.
- Task ownership/status.
- Intended files/areas.
- Overlap warnings.
- Session status.
- Latest summaries.
- Blocked questions.
- Per-agent diffs.
- Branch-level combined diff.

The human remains the coordinator by default. A coordinator agent can exist later, but it should be explicit rather than silently controlling the workspace.

Avoid heavy file locking or enterprise workflow. The coordination layer should prevent confusion without killing the Conductor-like parallel feel.

## Diffs, Files, and Checkpoints

Archductor should show both per-agent diffs and branch-level diffs.

### Per-Agent Diff

Each session should expose:

- Files touched.
- Patch contribution.
- Relevant commands/checks.
- Summary.
- Risks/blockers.
- Task association.

This is required for many concurrent agents. Without it, review becomes archaeology.

### Branch Diff

The workspace should expose the aggregate branch diff for final review and PR preparation.

### Checkpoint Commits

Checkpoint commits should be optional.

Do not always commit per session. That creates ugly history and constrains the Conductor-like workflow.

Do support:

- Manual checkpoint.
- Session checkpoint.
- Task checkpoint.
- Rollback to checkpoint.
- Compare checkpoint to current branch.

Final commit and PR structure should remain human/PR controlled.

## Review and PR Flow

PR is the main handoff boundary.

Flow:

1. Agent or human starts work in a branch workspace.
2. One or more sessions modify files.
3. Archductor tracks summaries, checks, diffs, and risks.
4. Workspace reaches ready-for-review state.
5. Agent/Archductor can open a PR.
6. Human reviews in GitHub or Archductor.
7. Merge happens outside Archductor or through an explicit user-triggered action later.

Archductor should optimize for opening good PRs:

- Clean title/body.
- Workspace summary.
- Per-agent contribution summary.
- Test/check evidence.
- Known risks.
- Files changed.
- Links back to sessions.

Draft vs ready-for-review PR policy should be configurable, but early product should bias toward PR as review handoff, not autonomous merge.

## Background Work

Archductor should support background development tasks.

This is in scope:

- Create workspace from task/API/CLI/MCP.
- Spawn one or more agents.
- Run in background.
- Update summaries.
- Run checks.
- Prepare diff/review.
- Open PR.
- Notify or mark ready for human review.

This is not a generic automation platform. Background work should be scoped to development branches, coding tasks, checks, reviews, and PRs.

## MCP, API, and CLI

Archductor should be API-first for product primitives, not for pixels.

MCP/API/CLI should expose near-parity for real workflow objects:

- Workspaces.
- Branches.
- Tasks.
- Agent sessions.
- Prompts.
- Start/stop/pause/resume/archive.
- Commands/checks.
- Files/artifacts.
- Summaries.
- Context injection.
- Review status.
- PR creation/status.
- Background task creation.

UI-only details do not need parity:

- Panel split.
- Selected tab.
- Chat scroll position.
- Local visual filters.

This makes the UI one client among several while avoiding API bloat around presentation state.

## Backend Architecture

Archductor should use a hybrid local/server daemon plus client architecture.

### Daemon

The daemon owns:

- Repositories.
- Workspaces/branches.
- Worktrees or isolated checkouts.
- Agent session processes.
- Terminals.
- Command execution.
- File watching.
- Diffs.
- Checks.
- Summaries.
- PR integration.
- API/MCP/CLI surfaces.

### Client

The client can be native, web, or both.

It owns:

- Layout.
- Workspace navigation.
- Chat/file UI.
- Right-panel tabs.
- Review interactions.
- Terminal display.
- Notifications.

### Why This Architecture

This is the only shape that preserves Conductor-like local workspace semantics while supporting:

- Remote access.
- Background jobs.
- API-triggered work.
- MCP clients.
- CLI workflows.
- Server-hosted execution later.

The daemon is the product primitive owner. The UI is a high-quality client over those primitives.

## Data Model Sketch

### Workspace

Fields:

- `id`
- `repo_ids`
- `branch`
- `base_branch`
- `path`
- `status`
- `created_at`
- `updated_at`
- `archived_at`
- `pr_id`
- `summary_id`

### Task

Fields:

- `id`
- `workspace_id`
- `title`
- `body`
- `status`
- `owner_session_id`
- `intended_areas`
- `blocked_reason`
- `created_at`
- `updated_at`

### Agent Session

Fields:

- `id`
- `workspace_id`
- `task_id`
- `harness`
- `model`
- `status`
- `prompt`
- `summary_id`
- `intended_areas`
- `files_touched`
- `started_at`
- `ended_at`

### Summary

Fields:

- `id`
- `scope_type`: session, task, workspace, review
- `scope_id`
- `body_markdown`
- `source_refs`
- `created_at`
- `updated_at`

### Check

Fields:

- `id`
- `workspace_id`
- `session_id`
- `command`
- `status`
- `exit_code`
- `output_ref`
- `started_at`
- `ended_at`

### Diff Contribution

Fields:

- `id`
- `workspace_id`
- `session_id`
- `files`
- `patch_ref`
- `still_present`
- `created_at`

### Context Attachment

Fields:

- `id`
- `workspace_id`
- `source`: local, archivum
- `type`: note, summary, context_pack, file, memory
- `body_or_ref`
- `scope`
- `created_at`

## First Wow Moments

Primary:

**It feels like Conductor, but I can run it from anywhere.**

Secondary:

**I can run a swarm on one branch without losing track.**

Third:

**It opens PRs while I am away.**

Suite-level:

**My agents have high-quality context from Archivum.**

The first release should not chase all of these equally. The migration feel matters most. If Archductor does not feel like Conductor, adoption will fail before the future platform value matters.

## Open Questions

- How much of Conductor's current UI language should be copied directly versus reinterpreted?
- Should workspace = branch be enforced technically, or can multiple branch-like worktrees appear under one logical workspace later?
- What are the first supported harnesses?
- How should background PR creation authenticate with GitHub?
- Should PR review happen primarily in GitHub, Archductor, or both?
- What is the minimum local summary quality needed when Archivum is disabled?
- What is the first useful Archivum context-pack integration?
- How should remote access be secured for personal use?

## Working Recommendation

Build Archductor as a focused, Conductor-like development workspace system with a daemon-owned backend.

Keep the visible model familiar:

- Branch workspaces on the left.
- Chats/files in the center.
- Tasks/summaries/files/changes/checks/context/review/PR on the right.
- Terminals/logs/check output docked bottom-right.

Use the backend to extend reach:

- API/CLI/MCP access.
- Background workspace tasks.
- Many sessions per branch.
- Per-agent and branch-level diffs.
- Optional checkpoints.
- PR handoff.
- Archivum context tab when enabled.

Do not make Archductor carry the whole Perceo vision in its UI. Let it be the stable development carrier that makes the rest of the suite useful.

