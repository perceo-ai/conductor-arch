# Fedora Package Review Draft

Human owner: fill this in before filing.

Do not file this from an agent account. A Fedora contributor must review the
spec, own the review bug, answer reviewer questions, and make any required
AI-use disclosure under Fedora policy in effect on the filing date.

## Package

- Name: `archductor`
- Version: `<version>`
- Upstream: `https://github.com/perceo-ai/conductor-arch`
- License: Apache-2.0
- Summary: parallel coding-agent workflow tool built around Git worktrees
- Initial scope: headless CLI plus `archcar` daemon. Electron desktop packaging
  should be reviewed separately if Fedora policy allows the bundled app shape.

## Proposed Review Bug Body

```text
Spec URL: <spec-url>
SRPM URL: <srpm-url>
Description:
Archductor is a Linux-first desktop control plane and headless CLI for running
coding agents across isolated Git worktree workspaces. This package starts with
the headless CLI and archcar daemon.

Fedora Account System Username: <fas-username>

<AI assistance disclosure if required by Fedora policy at filing time.>
```

## Human Checklist

- Write a Fedora-compliant `.spec`; do not reuse `nfpm.yaml` as the official
  Fedora package source.
- Run `fedpkg lint`, `rpmlint`, and a `mock` build.
- Confirm bundled Rust crate handling and license metadata.
- Decide whether the Electron desktop package is out of scope for the first
  Fedora review.
- Keep reviewer conversation and ongoing maintainership human-owned.
