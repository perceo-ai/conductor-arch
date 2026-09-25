# Homebrew/Core PR Draft

Human owner: fill this in before filing.

Do not open a Homebrew/core PR from an agent account. A human contributor must
review the formula, own the PR, answer maintainer questions, and follow
Homebrew's current AI-assisted contribution rules.

## Current State

The maintained formula lives at `packaging/homebrew/Formula/archductor.rb` and
is published to the Perceo tap. It is intentionally CLI/headless: it installs
`archductor` and `archcar`, not the Electron desktop app.

## Human Checklist

- Confirm Homebrew/core accepts the package shape and platform support.
- Confirm the current release is stable and tagged.
- Run:

```bash
brew audit --new --formula packaging/homebrew/Formula/archductor.rb
brew install --build-from-source packaging/homebrew/Formula/archductor.rb
brew test archductor
archductor doctor
```

- Update the formula to Homebrew/core style if maintainers request it.
- Include any required AI-use disclosure in the PR body.
- Keep maintainer review responses human-owned.

## PR Body Skeleton

```text
Created with `brew bump-formula-pr` or by following Homebrew's current new
formula workflow.

Archductor is a parallel coding-agent workflow tool built around Git worktrees.
This formula installs the headless CLI and archcar daemon.

Tests:
- brew audit --new --formula archductor
- brew install --build-from-source archductor
- brew test archductor
- archductor doctor

<AI assistance disclosure if required by Homebrew policy at submission time.>
```
