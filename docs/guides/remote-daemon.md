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

Install the CLI and daemon by whichever channel you prefer — the tarball, the
`.deb`/`.rpm`, the AUR package, Nix, or Homebrew all ship both `archductor` and
`archcar`. Then:

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

Without `--clone-into` the import stops and asks rather than picking a directory
on your disk. With it, the whole first-time flow is one command — which matters
precisely here, since `repo add` is refused while a remote profile is active.

In the app this is "Copy to this machine" on a workspace's right-click menu,
shown only while a remote client is selected.

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
