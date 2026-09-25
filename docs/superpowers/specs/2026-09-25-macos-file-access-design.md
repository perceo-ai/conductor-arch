# macOS file access for the archcar daemon

Date: 2026-09-25
Status: approved design, not yet implemented

## Problem

Adding a repository that lives under `~/Documents`, `~/Desktop` or
`~/Downloads` fails from the desktop with:

```
/Users/<user>/Documents/dev/personal/conductor-arch is not a Git repository
```

The path is a Git repository. The message is wrong.

### Root cause

`archcar` runs as a launchd agent (`~/Library/LaunchAgents/ai.perceo.archductor.archcar.plist`,
`ProgramArguments` = `/Applications/archductor-desktop.app/Contents/Resources/bin/archcar`).
A process launchd starts is its own TCC subject — it does not inherit the
Electron app's grants, and having no GUI it can never raise a consent prompt.
macOS therefore denies it access to the protected folders (Documents, Desktop,
Downloads) silently.

`resolve_git_repository_root` (`crates/core/src/repository.rs:219`) runs
`git -C <path> rev-parse --show-toplevel`, discards stderr, and reports *any*
non-zero exit as "is not a Git repository". The real stderr is
`fatal: cannot change to '<path>': Operation not permitted`.

Confirmed by probing the live daemon over its socket with `add_repository`:

| root | result |
| --- | --- |
| `~/archductor/tccprobe` | `repository_added` |
| `~/Documents/tccprobe` | `... is not a Git repository` |
| `~/Desktop/tccprobe` | `... is not a Git repository` |
| `~/Downloads/tccprobe` | `... is not a Git repository` |

Same daemon, same user, same code path. Only the protected folders fail.

## Goals

1. Ask for the access at install / first open instead of failing later.
2. Never report a permission denial as "not a Git repository" again.
3. Keep the daemon independently launchable — headless and remote daemons are
   a first-class target, so nothing may depend on the daemon being a child of
   a GUI process.

## Non-goals

- Sandboxing or App Store distribution changes.
- Any new permission model on Linux or Windows. TCC is macOS-only; on other
  platforms this feature reports nothing and renders nothing.

## Key constraint

Permission state is a property of **the daemon's host**, not of the client
application. A desktop client pointed at a remote daemon must report the
*remote's* state. That places the probe in the daemon and its result in the
RPC payload, not in Electron.

## Design

### 1. Daemon-side probe — new `crates/core/src/file_access.rs`

```rust
pub enum FileAccessState { Granted, Denied, Absent }

pub struct FileAccessProbe {
    pub root: PathBuf,
    pub state: FileAccessState,
    pub detail: String,
}

pub fn probe_roots(extra: &[PathBuf]) -> Vec<FileAccessProbe>;
```

- macOS only. On every other target `probe_roots` returns an empty vec.
- Roots probed: `~/Documents`, `~/Desktop`, `~/Downloads`, plus the root of
  every registered repository (`extra`).
- A probe reads one entry with `read_dir`. `ErrorKind::PermissionDenied` ⇒
  `Denied`. A root that does not exist ⇒ `Absent` and is dropped from the
  report.
- Runs inside the daemon process. Run anywhere else the answer is meaningless,
  because the calling shell has access the daemon lacks.

### 2. Carried by the existing readiness report

`crates/core/src/doctor.rs`:

- `SetupReadiness` gains `file_access: Vec<FileAccessProbe>`.
- `SetupReport::from_readiness` emits one **File access** row when any probe is
  `Denied`, listing the denied roots in its detail.
- `SetupRow` gains `action: Option<String>`, set to `"grant_file_access"` on
  that row, so a client can act on it without matching the display name.
  Serialized with `#[serde(default, skip_serializing_if = "Option::is_none")]`
  so older clients and daemons stay compatible.

The row is **not** a blocker: `setup_blockers` is unchanged. Repositories that
live outside the protected folders need no grant at all, and gating the whole
application behind a permission the user may not need is the wrong trade. The
row escalates to a blocker only when a root of an already-registered
repository is denied — at that point the daemon genuinely cannot do its job.

### 3. Grant flow — desktop, macOS only

New `desktop/electron/fileAccess.ts`, exposed through the preload bridge:

- `openSettings()` — `shell.openExternal("x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles")`
- `revealDaemon()` — `shell.showItemInFolder(archcarBinary())`, giving the user
  the drag target for the Full Disk Access list
- `restartDaemon()` — `launchctl kickstart -k gui/<uid>/ai.perceo.archductor.archcar`
  when a launchd unit is installed; otherwise terminate and re-spawn the child
  started by `ensureDaemonOnce` (`desktop/electron/archcar.ts:577`)

UI: a `PermissionCard` rendered inside `SetupModal`
(`desktop/src/components/SetupModal.tsx`) on first open and after an update. It
explains what is blocked, offers the three actions above, and polls
`get_setup_readiness { recheck: true }` every 2s while visible so the card
clears itself once the grant lands. `AddProjectForm` shows the same explanation
inline when an add fails with the permission error from §4.

### 4. Honest errors

`resolve_git_repository_root` captures stderr rather than discarding it:

- non-zero exit ⇒ error includes the trimmed stderr
- stderr matching `Operation not permitted`, or an io error of
  `ErrorKind::PermissionDenied`, ⇒ a distinct error naming the daemon binary
  and the fix, not "is not a Git repository"

The same mapping applies to the `canonicalize` call at `repository.rs:57` and
to `clone_repository`'s destination, which fails identically today.

### 5. CLI parity

`archductor service doctor` prints a File access section.

Today it calls `service::doctor` in the calling shell
(`crates/cli/src/main.rs:3327`). That shell has the access the daemon lacks, so
a probe run there would always report "granted" — the exact failure this design
exists to prevent. The command routes through the `ServiceDoctor` RPC when a
daemon is reachable; with no daemon it probes locally and labels the section
*probed by this shell, not the daemon*.

`archductor repo doctor` reports the same rows for registered repository roots.

### 6. Remote and headless daemons

The probe result travels in the RPC payload and always describes the daemon's
own host.

- Linux or Windows daemon: empty list, no row, no UI, nothing to explain.
- Remote macOS daemon: the row names the host and states that the grant must
  happen there. The local deep-link buttons are hidden, matching the wording
  `SetupModal` already uses for remote tool checks.

### 7. Opportunistic native prompt

`ensureDaemonOnce` already spawns `archcar` as a detached child of the Electron
app when no service unit is installed. A child spawned that way is expected to
inherit the app's TCC responsibility, which would mean macOS shows the ordinary
"would like to access files in your Documents folder" prompt and the app's grant
covers the daemon.

**This remains undetermined.** It cannot be settled from a development run: a
daemon spawned by `npm run dev` inherits the *terminal's* grants, not the app's,
so it sees the protected folders either way and proves nothing. The honest
experiment needs the packaged `.app` launched from Finder with the LaunchAgent
removed:

```
archductor service uninstall
open /Applications/archductor-desktop.app
# add a repository under ~/Documents from the UI
archductor service install   # restore the agent afterwards
```

A prompt plus a successful add means the child inherits; the permission error
with no prompt means it does not.

The design does not depend on the answer either way, because depending on it
would make the good path exclusive to GUI-attached daemons — exactly what goal 3
rules out. The answer only changes how often users meet the Full Disk Access
step.

## Testing

Rust:

- probe classification against a `mode 000` directory (denies on macOS and on
  Linux CI alike), an absent root, and a readable root
- `probe_roots` returns empty on non-macOS targets
- `SetupReport` row construction: row present only when something is denied,
  `action` set, blocker escalation when a registered repo root is denied
- error mapping: git stderr containing `Operation not permitted` produces the
  permission error; an ordinary non-repository directory still produces the
  existing message

TypeScript (vitest):

- `PermissionCard` renders the denied roots and the three actions
- polling clears the card when readiness flips to granted
- `AddProjectForm` shows the permission hint for the permission error and the
  generic message otherwise

Smokes, per `CLAUDE.md`:

- CLI: `archductor service doctor` against a running daemon and with none
- Electron: the desktop smoke, covering the first-open card
- manual: re-run the socket probe against `~/Documents` after granting Full
  Disk Access to the daemon binary, expecting `repository_added`

## Immediate workaround (pre-fix)

System Settings → Privacy & Security → Full Disk Access → add
`/Applications/archductor-desktop.app/Contents/Resources/bin/archcar`, then:

```
launchctl kickstart -k gui/$UID/ai.perceo.archductor.archcar
```
