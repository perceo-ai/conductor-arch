# Settings, Dashboard, and History UI Design

## Goal

Make the Settings, Dashboard, and History pages understandable without prior
Archductor knowledge, while ensuring configured prompts actually affect the
chat workflows they describe.

The pass should improve customer-visible behavior with focused changes to the
existing settings, workspace, and GTK systems. It should not introduce a new
configuration framework or rewrite the application shell.

## Current Problems

### Settings

- The page subtitle describes its implementation instead of helping the user.
- Shared and Local are independent toggle buttons without a clear tab state.
- A long diagnostic status sentence sits beside the tabs.
- The project selector remains visible for Shared settings.
- Shared currently means repository-committed settings, although the intended
  meaning is defaults used by every Archductor project.
- Local shows settings that do not make sense as per-project overrides.
- Nested page, inspector, content, group, and field shells create excessive
  padding and card-like framing.

### Prompts

- Prompt-pack defaults are merged only by the effective repository loader. The
  Settings editor loads a raw file layer, so prompt fields can look empty even
  when effective defaults exist.
- `general` is copied into `.context/PROMPTS.md` when a workspace is created,
  but the GTK launch preview only starts the session and does not inject the
  displayed text as claimed.
- `create_pr` is used by the GTK create-PR action.
- `continue_work` is not used; the continue action incorrectly reads
  `create_pr`.
- `code_review` is copied into `.context/PROMPTS.md`, but review staging uses
  separate generated text.
- The remaining configured prompt fields are stored but are not consistently
  connected to their named workflows.
- Existing workspaces do not receive updated `.context/PROMPTS.md` content when
  settings change.

### Dashboard

- The status buckets use task-board language that does not accurately describe
  workspace runtime state.
- Cards look interactive but do not open their workspace.
- The page lacks a concise explanation of what it summarizes.
- Project filtering and status counts are visually weak.
- Nested board, column, and card padding makes the page heavier than necessary.

### History

- The page currently shows workspace state history, while retained chat-history
  loading and rendering code is no longer reachable.
- Documentation and verification expect both archived workspaces and saved
  local/imported chats.
- The subtitle does not clearly explain the page.
- Workspace detail is rendered as a long text dump instead of a scannable
  detail surface.

## Configuration Model

Archductor will resolve settings in this order, with later values overriding
earlier values:

1. Built-in defaults.
2. App-wide Shared defaults.
3. Existing repository-committed `.archductor/settings.toml` settings.
4. Per-project Local overrides from `.archductor/settings.local.toml`.

The repository-committed layer remains supported so existing projects and team
configuration continue to work. The main Settings page exposes the two scopes
the user needs for everyday configuration:

- **Shared**: defaults applied to every Archductor project. No project selector
  is shown.
- **Local**: overrides for the selected project. The project selector is shown.

Shared defaults are stored in `AppPaths::config_dir/settings.toml` (normally
`~/.config/archductor/settings.toml` on Linux and the Archductor roaming config
directory on Windows). The file uses the existing repository-settings schema
for the fields allowed at Shared scope. This keeps configuration inspectable and
portable without adding a new database settings system.

Shared should surface settings that sensibly apply across projects:

- Default prompts and prompt behavior.
- Default agent, model, approval, reasoning, and provider preferences.
- Provider executable paths and provider routing used on this machine.
- Terminal, theme, density, shortcut, command-palette, and notification
  preferences.
- App-wide privacy behavior where supported.

Local should surface settings that depend on a project or its workspaces:

- Scripts and check commands.
- Environment values and local file references.
- Files-to-copy rules.
- Git, branch, naming, merge, and archive behavior.
- Workspace parent, base branch, working directory, ports, and workspace
  defaults.
- Project-specific prompt overrides where a project needs different guidance
  from Shared defaults.
- Advanced project customization TOML.

The core settings resolver must be shared by GTK behavior and CLI-visible
workspace/session behavior. The UI must not maintain a separate interpretation
of effective settings.

## Settings Page Design

The header copy will explain the customer-facing distinction between reusable
defaults and project overrides.

Shared and Local will use the app's existing workspace chat-tab visual pattern,
including its tab shell, active state, spacing, hover treatment, and typography.
This pass must reuse or extract the current chat-tab styling rather than invent
a separate segmented-control appearance. Scope help appears below the tabs and
changes with the selected scope. Save, load, and error messages move to a
dedicated status area rather than occupying the tab row.

The project selector and project-only actions are visible only for Local. Shared
loads even when no projects exist. Local shows a useful empty state when no
project exists.

Sections that do not belong to the active scope are hidden rather than shown as
empty or disabled. The left rail updates with the available sections and keeps
the nearest valid section selected when the scope changes.

The layout will remove redundant outer borders, shadows, and nested padding.
Groups remain visually separated, but fields should read as form rows rather
than cards inside cards.

Autosave remains debounced. Scope or project changes flush a pending save before
loading the new target. Load and validation errors remain visible and use the
existing toast error path.

## Prompt Behavior

The editor shows the effective prompt for the active scope and clearly marks
whether it is inherited or overridden. Clearing a Local override restores the
Shared/repository value instead of saving an empty replacement.

Prompt resolution must be centralized by prompt kind. Each workflow requests a
named prompt from the effective settings resolver and combines it with runtime
context when needed:

- `new_workspace`: workspace-creation guidance.
- `general`: instructions supplied when starting a new supported agent chat.
- `continue_work`: continue/follow-up action.
- `summarize_session`: summary action.
- `handoff`: handoff action.
- `code_review`: staged code-review action.
- `create_pr`: create-PR action.
- `fix_errors`: failing-check and error action.
- `resolve_merge_conflicts`: conflict-resolution action.
- `rename_branch`: assisted branch-renaming action where surfaced.
- `commit_generation`: assisted commit action.
- `test_fixing`: test-failure action.
- `refactor_style`: refactor action where surfaced.
- `setup_script`: setup-script assistant action.
- `run_script`: run-script assistant action.

Workflows that do not yet have a surfaced chat action must not claim active use
in their help text. They may remain editable as defaults only if the UI labels
them honestly.

The false prompt-preview statement will be removed unless the launch path
actually sends the prompt. For supported Codex and Claude launches, `general`
must be included through the existing provider/session launch boundary and be
covered by tests. Saved prompt changes affect newly created chats and newly
staged actions. Existing provider turns are not silently rewritten.

`.context/PROMPTS.md` remains durable workspace context. New workspaces receive
the resolved prompt snapshot. When settings are saved, Archductor refreshes the
managed prompt snapshot for existing workspaces without modifying user-authored
brief, notes, or todo files.

## Dashboard Design

The Dashboard header explains that the page summarizes current workspace state
across projects.

Project filtering uses the standard workspace chat-tab treatment. If the
project count exceeds the practical tab width, the existing first-five limit is
replaced with a selector or overflow treatment that keeps every project
reachable.

Workspace buckets use state-oriented names:

- **Ready**: active workspace with no running process or open PR.
- **Running**: a run script or agent session is active.
- **Review**: an open pull request exists.
- **Archived**: the workspace is archived.

Column headers show counts. Empty columns use short state-specific copy.
Workspace cards show project, branch, activity, PR attention, changes, and open
todos without duplicating metadata. Clicking a card opens that workspace in the
normal workspace command center.

The board keeps horizontal scrolling for narrow windows. Styling removes the
extra page/column/card padding and avoids heavy shadows.

## History Design

History gains two real tabs:

- **Workspaces**: active, ready, review, and archived workspace records.
- **Chats**: saved Archductor chat threads, legacy local sessions, and imported
  Conductor chats when available.

Workspaces is the default tab because it includes archive history and lifecycle
state. Chats restores the existing session loading and transcript rendering
path. Each tab has accurate loading, empty, and failure states.

The workspace list supports All, Active, and Archived filtering. Selecting a
workspace shows a structured detail pane with state, project, branch/base,
changes, todos, sessions, PR, dates, and path. A visible Open Workspace action
navigates to an active workspace; archived entries remain inspectable.

Selecting a chat loads its transcript asynchronously as before. Source labels
use `Archductor`, `Legacy`, and `Imported Conductor` instead of platform-specific
labels that do not explain provenance.

Both tabs use the standard workspace chat-tab treatment and a flatter
split-pane layout.

## Error Handling

- Shared settings load/save failures identify the app-wide settings target.
- Local failures identify the selected project and file scope.
- Invalid TOML or field values do not overwrite the last valid settings.
- Dashboard database failures render one clear page error.
- History worker failures render an inline error and use the existing deduped
  toast path.
- Navigation callbacks safely no-op if their destination widget has already
  been destroyed.

## Testing and Verification

Written tests will cover:

- Effective settings precedence across built-in, Shared, repository, and Local
  layers.
- Scope-to-section visibility and selector visibility decisions.
- Prompt inheritance, clearing overrides, and prompt-kind routing.
- Codex and Claude launch behavior for resolved general prompts.
- Continue-work using `continue_work`, not `create_pr`.
- Managed prompt snapshot refresh without changing other context files.
- Dashboard bucket labels, project filtering, and navigation target selection.
- History workspace filters, chat source labels, and tab data selection.

CLI smoke will prove that effective settings reach the command/session boundary
and that repository settings import/export remains compatible.

GTK smoke will build and run focused GTK tests, launch the app when a display is
available, and inspect Settings, Dashboard, and both History tabs. If a real
display is unavailable, the final report will state that runtime visual smoke
was not completed.

## Non-Goals

- Replacing TOML configuration with a new database-backed settings framework.
- Removing repository-committed settings.
- Building new chat actions solely to consume every historical prompt field.
- Rewriting the app shell or workspace command center.
- Adding cloud sync or cross-device settings sync.
