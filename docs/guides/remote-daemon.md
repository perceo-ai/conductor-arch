# Running the daemon on a server

The machine that should run five agents, five dev servers, and a test suite is
often not the laptop in front of you. Because `archcar` owns all the state and
every surface is a client of it, moving execution to a server is a deployment
choice rather than a different product.

Nothing here requires a display on the server. It has no GUI dependency at all.

## What ends up where

| On the server | On your laptop |
| --- | --- |
| The `archcar` daemon and its SQLite state | The desktop app or the CLI |
| Repository clones and every worktree | Nothing repository-shaped, unless you import a workspace |
| Agent CLIs (`codex`, `claude`) and their authentication | Your SSH key |
| `gh` and its authentication | |
| Sessions, terminals, scripts, checks, background tasks, PR operations | |

The consequence people trip over: **agent CLI auth and `gh auth login` have to
happen on the server.** Authenticating on your laptop does nothing for a
server-hosted session.

## Set up the server

Install the CLI and daemon by whichever channel you prefer — the tarball, CLI
AppImage, AUR package, Nix, Homebrew, or the APT/DNF `archductor` package all
ship both `archductor` and `archcar`. Then:

```bash
archductor service setup
```

That installs the background service (a systemd user unit on Linux, a launchd
agent on macOS, a Task Scheduler logon task on Windows), starts it, provisions
an access token, and reports whether the daemon can reach the tools it needs.

Add `--listen 0.0.0.0:7420` only if clients will use the TCP transport. **For
SSH, which is what you should use, omit it** — SSH needs no open port.

`service setup` exits non-zero if the daemon did not start, so a provisioning
script can trust its status, and it refuses to print connection instructions
for a listener that is not actually up.

Two things it handles that are easy to get wrong by hand:

**Surviving logout.** systemd stops a user manager when the user's last login
session ends, so a unit you install over SSH dies the moment you disconnect.
Install runs `loginctl enable-linger` and tells you if it could not.
`archductor service status` reports `boot_persistent`.

**The daemon's `PATH`.** launchd gives a job `/usr/bin:/bin:/usr/sbin:/sbin`,
and a systemd user unit is barely richer. Neither can see Homebrew, a version
manager, or `~/.local/bin`, so the daemon fails to find `codex` even though your
shell finds it instantly. Install probes your login shell and bakes the
resulting `PATH` into the unit.

```bash
archductor service status
archductor service doctor    # resolves git, gh, and agent CLIs against the SERVICE's PATH
archductor service token     # print the token; --rotate to replace it
archductor service uninstall
```

`service doctor` is the check that distinguishes "the service is running" from
"the service is usable". Run it after any change to how tools are installed.

### Platform caveats

- **macOS**: a launchd *agent* starts at login, not at boot. On a headless Mac,
  log in once after a reboot, or install a root-owned LaunchDaemon yourself.
- **Windows**: logon tasks have the same scope. Running while logged off means
  storing the account password in Task Scheduler, which Archductor will not do
  on your behalf.
- **AppImage**: install refuses to write a unit pointing into an AppImage's
  temporary mount (`/tmp/.mount_*`), because that unit works right up until the
  next reboot. Extract or install properly on a server.

## Connect from a client machine

```bash
# SSH — recommended
archductor remote connect ssh://you@server

# Token over TCP — loopback or a network you already trust
archductor remote connect server:7420 --token <token>

archductor remote status      # where requests go, and over which transport
archductor remote disconnect  # back to this machine's local daemon
```

`connect` verifies the daemon responds before saving, so a typo fails fast
instead of half-configuring the machine.

One profile moves the whole machine: the CLI, the desktop app (Settings →
Remote daemon), and `archductor mcp serve` all follow it. The desktop app will
not spawn a local sidecar while a remote is configured.

Resolution order, highest first:

1. `ARCHDUCTOR_ARCHCAR_REMOTE` / `ARCHDUCTOR_ARCHCAR_TOKEN` in the environment
2. The saved profile (`$XDG_STATE_HOME/archductor/remote.json`, owner-only)
3. The local daemon

### Why SSH rather than the token

|  | SSH | Token over TCP |
| --- | --- | --- |
| Encryption | yes, by sshd | **none** |
| Identity | your SSH key, per user | one shared token for everyone |
| Revoke one user | remove their `authorized_keys` line | impossible — rotating cuts off everybody |
| Open port on the daemon | none | yes |
| Server setup | sshd, which a headless box already runs | `--listen`, plus a firewall you trust |

`ssh://` runs `archductor archcar stdio-proxy` on the far side and pipes the
protocol through the SSH connection. The destination is handed to `ssh`
verbatim, so `~/.ssh/config` applies — host aliases, jump hosts, and per-host
keys all work.

If `archductor` is not on the non-interactive `PATH` over SSH, give the path
explicitly:

```bash
archductor remote connect ssh://you@server/opt/archductor/bin/archductor
```

> **On the TCP transport.** It is a shared bearer token in cleartext: no TLS, no
> per-client identity, and rotating the token revokes every client at once. A
> bare port (`--listen 7420`) binds loopback only; anything else must sit behind
> a VPN, an SSH tunnel, or a TLS reverse proxy. Use `ssh://` and none of this
> applies.

## Several daemons

Save more than one and switch between them — a work server, a home box, and
your laptop.

```bash
archductor remote connect ssh://you@build-box --label build
archductor remote connect ssh://you@home-nas --label home
archductor remote list
archductor remote use build
archductor remote use local           # or: this-machine
archductor remote remove home
```

The label is what appears in the app's switcher.

## Working against a remote

Most commands behave the same; paths are the exception, because they resolve on
the *daemon's* filesystem, not yours.

`archductor repo add` is refused while a remote profile is active — it takes a
local path that means nothing on the server. Use the daemon-side command
instead:

```bash
archductor archcar add-repository /srv/git/my-app --name my-app
archductor archcar create-workspace my-app fix-auth fix/auth --base-ref main
```

Two commands answer "is the *server* healthy", as opposed to this machine:

```bash
archductor archcar service-status   # follows the remote connection
archductor archcar service-doctor
```

`archductor service status` and `archductor service doctor`, without `archcar`,
always answer for the machine you typed them on. That distinction matters when
you are debugging a session that will not start.

## Pulling a workspace back to your machine

You reviewed something on the server and now want it locally — same branch,
same conversation. `remote import` reads from the remote and writes to your
*local* daemon, matching repositories by clone URL rather than by path. Both
daemons are contacted; neither talks to the other.

```bash
archductor remote import fix-auth --thread-id 12

# First time on this machine, when it has no clone of the repository:
archductor remote import fix-auth --thread-id 12 --clone-into ~/src/my-app
```

Omit `--thread-id` to import the workspace without a chat. `--name` and
`--branch` rename it locally.

The branch travels through the git remote, not between the daemons. Import
pushes the source workspace's branch from the server first (`git push -u`,
which also sets the server copy's upstream to it), then starts the local
workspace at that tip with the same diff base, so review shows the same work on
both machines. If the server worktree still has uncommitted files, Archductor
stages them all and creates a transfer checkpoint commit before pushing.

Repositories are matched by remote URL across the forms two machines use
(`git@github.com:`, `https://github.com/`, `ssh://…:22/`). A clone made through
an `~/.ssh/config` Host alias (`git@git-personal:you/app.git`) matches by its
`owner/repo` path when exactly one local repository has that path; if two do,
the import asks rather than guessing. `--clone-into` clones with the *server's*
URL, so if that uses a Host alias this machine lacks, clone the repository
yourself, register it here (`archductor remote use local`, then
`archductor repo add <path>`), and import with `--from <client>`.

Without `--clone-into` the import stops and asks rather than picking a directory
on your disk. With it, the whole first-time flow is one command — which matters
precisely here, since `repo add` is refused while a remote profile is active.

In the app this is "Copy to this machine" on a workspace's right-click menu,
shown only while a remote client is selected. It carries the workspace's most
recently active chat, and when this machine has no clone it asks for a folder
to clone into.

Import *copies*: the source workspace keeps running and the chat it carries
lands with no session reading it. To move a workspace instead — stopping the
source, resuming the target, and retiring the source workspace — see
[Moving a workspace between daemons](#moving-a-workspace-between-daemons).

## Moving a workspace between daemons

`remote import` copies. The source keeps running, which is how two daemons end
up driving one branch, and the chat it carries lands inert: the transcript is
there, nothing is reading it. `remote transfer` moves instead.

```bash
# Off the server and onto this machine.
archductor remote transfer fix-auth --from office

# Between two servers, with neither being this machine.
archductor remote transfer fix-auth --from office --to frankfurt
```

Omit `--to` to target this machine; omit `--from` to read from the active
client, as `import` does. `local` and `this-machine` name the local daemon
explicitly for either flag.

Pointing both ends at one daemon is refused, and the two ends are compared by
asking each daemon who it is rather than by the addresses you typed — so a
saved client that happens to point at this machine is caught too:

```
Error: `--from office` and `--to local` are the same daemon reached two ways; a transfer needs two. Moving a workspace onto the daemon it is already on would archive the very workspace it just resumed
```

A daemon too old to answer that question falls back to comparing addresses,
which catches only the identical-string case; the command says so when it
happens rather than implying the stronger check ran.

`--name` and `--branch` choose the workspace name and branch on the target,
which is also how you get past a name the target already uses. `--clone-into`
clones onto the *target* daemon when it has no copy of the repository, rather
than onto this machine. `--thread-id` picks which chat moves; the default is
the workspace's most recently touched live chat, which is the one you were
looking at. (This differs from `import`, where omitting `--thread-id` means "no
chat at all" — a move with no conversation is rarely what you meant.)

In order, the transfer:

1. **Stops** the source's sessions. Without `--force` a live session refuses
   the whole thing and nothing is pushed or changed:

   ```
   Error: `fix-auth` on office still has a session running: session 1 (codex, "Codex Chat 1"). Nothing has been pushed and nothing has changed. Let it finish, or retry with `--force` to stop it — its turn is lost either way
   ```

   With `--force` each session is killed and then *waited on* until the source
   daemon agrees it is gone, before anything is pushed. An agent that is still
   writing the worktree would otherwise leave the target starting from a commit
   the source had already moved past.

2. **Publishes** the branch, exactly as `import` does. If the source worktree
   still has uncommitted files, Archductor stages them all and creates a
   transfer checkpoint commit before pushing, so the target starts from the full
   source state instead of asking you to commit and retry.

3. **Creates** the workspace on `--to`, at the commit that was pushed, with the
   source's diff base and the transcript. This is the same
   `import_workspace_from_remote` request `import` sends; it writes through
   whichever daemon receives it, which is why the target can be any saved
   client and not just this machine.

4. **Resumes** it: a session starts on the target under the chat's own provider
   and is handed one message. Which message is decided by the transcript's last
   entry, not by whether the agent happened to be mid-turn, so the same
   transcript always produces the same handover:

   - **Last entry is from the user.** There is a pending ask, so it is replayed
     verbatim under the preamble:

     ```
     This conversation moved from daemon office to frankfurt; the branch is at 5055711. Continue from where the transcript leaves off — do not redo completed work.

     Wire up the parser
     ```

   - **Last entry is from the agent** (it was explaining something when the
     source stopped), or the chat is empty. There is nothing to replay, so a
     fixed continuation prompt is sent instead:

     ```
     This conversation moved from daemon office to frankfurt; the branch is at 5055711. Pick up where you left off and continue the work — do not redo anything already done.
     ```

     A chat with *nothing* said in it yet is this second case. Importing a
     workspace only opens a chat on the target when there are messages to
     carry, so the transfer opens one itself — same provider, same title — and
     sends the continuation prompt into it. (Being a brand-new chat, its first
     turn also carries the repository's `general` prompt, as any first message
     does.)

   The transcript itself is seeded on the target and replayed to the agent on
   its first turn by the same path a forked chat uses, so the handover message
   only has to say what moved and what to do next.

5. **Retires** the source workspace, by archiving it — never deleting. The
   worktree stays on disk and `archductor workspace restore <name>` brings it
   back. This happens only after step 4 confirms the message reached the
   target's session; a target that could not take the work must not cost you
   the one live copy of it.

   "Confirmed" means the message is in the target chat's own history, not that
   the queue it was put on is empty. A queued message is removed from the queue
   *before* the session writes it out and put back if that write fails, so an
   empty queue can mean "in flight" or "about to be retried". If the session
   that was meant to take it dies first — an agent that fails to start, say —
   the transfer says so and leaves the source alone:

   ```
   Error: the session started for `fix-auth` on frankfurt stopped before taking the conversation, so it was never delivered; `fix-auth` on the source has been left alone — fix the agent there and re-run
   ```

### When a transfer stops part-way

Anything that fails after step 1 prints what exists now, so you can see what a
retry will skip:

```
transfer of `fix-auth` from office to frankfurt stopped part-way. State now:
  [x] stop: the source's sessions on office
  [x] publish: branch pushed at 5055711
  [ ] create: the workspace on frankfurt
  [ ] resume: session started on the target and handed the conversation
  [ ] retire: source workspace archived on office
Re-run the same command to continue; finished steps are detected and skipped.
```

Re-running the same command is safe. Two checks make it so.

**The workspace.** A workspace already on the target is reused rather than
imported again — and it is recognised by *what it is*, not by what it is
called: in the source's repository (matched by remote URL, since registration
names are per-daemon) and at the commit this transfer pushed.

```
`fix-auth` is already on frankfurt (branch lc/fix-auth); keeping it rather than importing a second copy
```

Neither the workspace name nor the branch is used to identify it, because
neither is an identity: two repositories share branch names freely, and a
daemon keeps workspace names unique across the whole machine. Going by them
meant a retry could both miss its own earlier attempt and adopt a stranger's.
Matching on the pushed commit also means a retry still finds its target when
the daemon had to give it a different name (see the name collisions below).

Everything else refuses rather than guessing. Nothing is created or changed in
any of these cases, so the source workspace is still there:

- **The name is taken.** Workspace names are unique machine-wide, and a
  collision makes the daemon version the name *and* the branch into `-v2`
  forms — leaving a workspace a later retry could no longer recognise. So an
  unrelated workspace already using the name this transfer wants refuses it,
  rather than renaming around it:

  ```
  Error: frankfurt already uses the workspace name `fix-auth` for `fix-auth` (other-project, branch lc/fix-auth), and it keeps those names unique — so importing would quietly rename this transfer's workspace *and* its branch to `-v2` forms, leaving something a retry could no longer recognise. Nothing has been changed. Give it a free name with `--name <name>` (and `--branch <branch>` if that collides too), or clear the one on frankfurt first
  ```

  Pick a free name with `--name <name>` (and `--branch <branch>` if the branch
  collides too), or clear the occupied name on the target and transfer again.
  The app has no name picker, so from the desktop the way through is to rename
  or remove the workspace holding that name on the target first.

- **An archived workspace still holds the branch.** It cannot be resumed while
  archived — that would look like success while being invisible on the
  target's board — and it cannot be imported around either, since an archived
  workspace keeps its branch and the import would version its way into a
  second worktree with another agent replaying the conversation:

  ```
  Error: `fix-auth` on frankfurt is archived but still holds branch lc/fix-auth, the branch this transfer moves. It cannot be resumed while archived, and importing alongside it would put a second worktree on a `-v2` branch with another agent replaying this conversation — so nothing has been changed. Restore it there (`archductor workspace restore fix-auth`) to continue the transfer into it, or delete it if it is finished with
  ```

- **The target has got on with the work.** A workspace on that branch but at a
  different commit has commits of its own. Within one repository a branch name
  *is* the branch, so the only safe answers are "my own earlier attempt, adopt
  it" and "work that has moved on, stop":

  ```
  Error: `fix-auth` on frankfurt is on branch lc/fix-auth but at 9f21abc, not the 5055711 this transfer pushed — that daemon's copy of this branch has its own commits. Importing a second workspace onto one branch is what this command exists to prevent, and re-seeding its chat would start that work twice, so nothing has been changed. If the transfer already completed there is nothing to re-run; otherwise move or rename `fix-auth` on frankfurt and retry
  ```

  That is the usual answer to "I re-ran a transfer that had already finished
  and the target had got on with the work": there is nothing left to re-run.

- **The workspace is there but the conversation is not.** An earlier attempt
  died before the chat was carried. Creating an empty chat there would silently
  drop the history, so this refuses too:

  ```
  Error: `fix-auth` is on frankfurt but has none of the conversation, so an earlier attempt created it without the chat. Remove that workspace there and re-run; `fix-auth` on office has been left alone
  ```

Adopting a workspace settles which *workspace* is this transfer's, not which
chat in it is the imported one — so the chat is identified rather than guessed:
one that already has this transfer's handover, else one carrying the seeded
history an import writes, else the most recently touched. Without that, a chat
the operator had opened in the target themselves would be the newest, and would
receive the handover meant for the carried conversation.

**The handover.** A chat that has already been handed its transfer message is
left alone:

```
`fix-auth` on frankfurt was already handed the conversation; leaving its session alone
```

This reads the chat's own messages, not "is a session up?" — which stops being
true the moment you stop the agent, and a re-run after that would tell it to
continue work it has since finished. It counts only a message a session on
*that* daemon actually took, never one that arrived as part of a carried
transcript. That distinction is what makes chains work: a workspace moved from
A to B arrives at C carrying B's preamble in its history, and counting that as
a prior handover would skip C's session entirely while still archiving B.

In the app this is "Transfer to <daemon>…" on a workspace's right-click menu,
one entry per saved daemon other than the one it is on (plus "this machine"
while a remote is selected). A live agent on the source asks before it is
stopped rather than refusing outright, since clicking the item is already the
decision the CLI's `--force` stands in for.

Two differences from the CLI, both deliberate:

- The app always moves *off the daemon it is showing you*, so it has no `--from`
  of its own. The CLI can run an office→frankfurt transfer from a third machine
  that is neither end; the app cannot. Which daemon that is comes from the same
  answer the switcher label and the menu gating use, so it covers a daemon
  pinned by `ARCHDUCTOR_ARCHCAR_REMOTE` as well as a saved client or this
  machine. It is captured when you click, so switching daemons while a transfer
  runs does not redirect it — in particular not the archive at the end.
- `--clone-into` has no app equivalent for a remote target: the folder picker
  can only choose a path on this machine. Transferring onto a daemon with no
  clone of the repository asks you to register one there first.

## Updating daemons

Every daemon updates itself, so you update a server from your laptop instead
of logging in to reinstall:

```bash
archductor remote update --all --check   # versions of this machine and every saved daemon
archductor remote update build           # update one, without switching to it
archductor remote update --all           # update them all
```

Each daemon reports how it was installed, and that decides what "update" means:

| Installed from | What `remote update` does |
| --- | --- |
| Release tarball (`linux-x86_64`) | Downloads the release, checks it against the release's `SHA256SUMS`, swaps `archductor` and `archcar` in place, and restarts |
| apt, rpm, AUR, Homebrew, Nix, AppImage | Prints that channel's upgrade command to run on the server; once the new binary is on disk, `remote update` restarts the daemon onto it |
| Desktop app | The app updates itself; on its next launch it restarts its own daemon onto the new binary |

The restart goes through the service manager — the daemon exits and systemd
(`Restart=always`) or launchd (`KeepAlive`) starts the new binary — and
`remote update` waits until the daemon answers on the new version before it
reports success. The previous binaries stay beside the new ones as
`archductor.previous` and `archcar.previous`. A restart ends managed agent
sessions, so an update is refused while an agent is mid-turn; `--force` does it
anyway. A download that fails its checksum replaces nothing.

To stop thinking about it, let a daemon update itself when a release is out
and no agent is working:

```bash
archductor remote use build
archductor archcar auto-update on    # or off; `archductor archcar update-status` shows it
```

The desktop app has the same controls under Settings → Advanced → Updates, for
whichever daemon the client switcher has selected.

A daemon from before this feature cannot be updated remotely — it does not
understand the request, and `remote update` says so. Install the new release
on it by hand once and restart its service.

`ARCHDUCTOR_UPDATE_BASE_URL` points downloads at a mirror laid out like GitHub's
(`<base>/v<version>/archductor-<version>-<os>-<arch>.tar.gz` plus `SHA256SUMS`).
A mirror may serve targets GitHub releases do not, such as `linux-aarch64`.

## MCP against a remote

Because MCP tools are archcar requests, an MCP client pointed at a machine with
a saved remote profile drives the *server's* daemon:

```bash
archductor remote connect ssh://you@server
archductor mcp register --client claude
```

Your local Claude Code can now read and drive the server-hosted workspaces.
Prefer the default session profile over `--full` unless you specifically want
an agent that can create and archive workspaces.

## Protocol details

`docs/api.md` documents the transports, the envelope format, the workflow
objects, and the stability policy. Read it if you are writing a client rather
than operating one.
