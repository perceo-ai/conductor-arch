# Debian ITP Draft

Human owner: fill this in before filing.

Do not file this from an agent account. A Debian contributor must review the
package, own the bug, answer maintainer questions, and make any required AI-use
disclosure under the Debian rules in effect on the filing date.

## Package

- Package name: `archductor`
- Version: `<version>`
- Upstream: `https://github.com/perceo-ai/conductor-arch`
- License: Apache-2.0
- Language/toolchain: Rust; Electron desktop packaging is separate from the
  headless CLI package.
- Short description: parallel coding-agent workflow tool built around Git
  worktrees

## Proposed ITP Body

```text
Package: wnpp
Severity: wishlist
Owner: <human name> <email>
X-Debbugs-CC: debian-devel@lists.debian.org

* Package name    : archductor
  Version         : <version>
  Upstream Contact: Perceo <contact>
* URL             : https://github.com/perceo-ai/conductor-arch
* License         : Apache-2.0
  Programming Lang: Rust
  Description     : parallel coding-agent workflow tool built around Git worktrees

Archductor is a Linux-first desktop control plane and headless CLI for running
coding agents across isolated Git worktree workspaces. The headless package
installs the archductor CLI and archcar daemon; the Electron desktop package is
tracked separately because it has different packaging constraints.

I plan to maintain this package as <solo maintainer/team>. <AI assistance
disclosure if required by Debian policy at filing time.>
```

## Human Checklist

- Confirm whether Debian should package only the headless CLI first.
- Prepare Debian source packaging and copyright metadata.
- Run `lintian` and license checks.
- Decide whether to seek Rust team, Debian mentors, or another sponsor path.
- Keep maintainer review responses human-owned.
