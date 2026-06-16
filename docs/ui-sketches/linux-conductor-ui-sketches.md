# Linux Conductor UI Sketches

These sketches define a fast MVP interface for a Linux-native Conductor-like workflow. They are inspired by the public Conductor product layout: dark app chrome, a narrow workspace sidebar, central agent session surface, bottom composer, and review/checks affordances.

They are implementation wireframes, not a pixel clone of the macOS app.

## Sketches

- [Main workspace shell](./linux-conductor-main-workspace.svg)
- [New workspace flow](./linux-conductor-new-workspace.svg)
- [Review and checks panel](./linux-conductor-review-checks.svg)

## UI Principles

- Keep the first screen operational: repositories, workspaces, active sessions, diffs, checks, and run state should be visible without a landing page.
- Use a dark, dense layout suited to repeated developer work.
- Keep cards shallow and compact; reserve panels for functional surfaces like session output, diffs, checks, and forms.
- Use city/workspace names as stable anchors.
- Make branch, PR, and run state visible in the workspace row.
- Keep the bottom prompt composer attached to the active workspace and agent.
- Make review state visible before PR creation so the user does not need to leave the app to know whether work is ready.

## MVP Screen Set

### Main Workspace

The main screen has three regions:

- left sidebar for repositories, active workspaces, and archived workspaces
- center session area for agent chat, terminal output, and prompt composer
- right review area for changed files, checks, run status, todos, and PR state

This should be the default screen after opening a repository.

### New Workspace

The new workspace dialog creates a branch and worktree from a selected base ref. It should show the setup preview before creation so the user can catch bad branch names, wrong repos, or missing file-copy behavior early.

Minimum fields:

- repository
- base ref
- issue/task link
- workspace name
- branch name
- starting agent
- setup preview

### Review And Checks

The review screen focuses on merge readiness:

- changed files
- unified diff
- local comments
- send comments to agent
- PR state
- CI state
- todos
- merge readiness

The MVP can use a basic unified diff. Side-by-side diff and full GitHub review-thread syncing can wait until after the 2-3 day build.

## Visual References

- Official Conductor product page screenshot: https://www.conductor.build/
- Conductor docs workflow model: https://www.conductor.build/docs/concepts/workflow
- Conductor checks model: https://www.conductor.build/docs/reference/checks
- Conductor diff viewer model: https://www.conductor.build/docs/reference/diff-viewer

