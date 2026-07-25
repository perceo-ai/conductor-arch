# Archductor And Perceo Suite Release PRD

Current summary as of 2026-07-24. `docs/release-readiness.md` is the release
runbook; this file keeps the product and launch intent short.

## Positioning

Archductor is a local desktop control plane for running coding agents across
isolated Git worktree workspaces.

Short pitch: run Codex and Claude Code in parallel workspaces, review diffs,
create PRs, and archive finished work without juggling terminals.

Claims must stay tied to verified behavior. Linux is the primary validated
target. Windows ZIP remains preview-only until the real Windows checklist
passes. GitHub flows use local `gh` auth. Linear flows require
`LINEAR_API_KEY`.

## Release Levels

Internal dogfood:

- local release-readiness script passes
- GTK app launches locally
- at least one real repository completes the happy path
- blockers are recorded in `progress.md`

Public beta:

- Linux manual checklist passes for every announced package channel
- product page has install instructions, downloads, checksums, and known limits
- founder demo and feedback path are live
- GitHub release has release notes and artifacts

Public launch:

- beta feedback is triaged
- install/download analytics are wired
- support, rollback, and yank paths are tested
- screenshots, demo clips, social copy, and launch assets are current

## Product Gate

The public release loop is:

`project -> workspace -> agent/runtime -> review -> PR -> merge/archive -> history`

Required evidence is defined in `docs/release-readiness.md` and
`docs/manual-testing-checklist.md`. Do not call packaging release-ready until
the GUI-first loop passes on the announced platform and each package channel
has install, launch, upgrade, checksum, and rollback/yank validation.

## Website Gate

The Archductor product page on `perceo.ai` must show the real workflow, current
GTK screenshots, install instructions for supported channels only, prerequisites,
known limits from `progress.md`, release links, checksum/provenance verification,
and a feedback path.

Avoid broad AI productivity claims. Use founder-led, technical, concrete copy.
