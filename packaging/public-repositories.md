# Public Package Repositories

This is the release checklist for making Archductor installable from public
APT, DNF, and Homebrew repositories. It covers Perceo-owned repositories first:
those are the paths we can automate. Official Debian, Ubuntu, Fedora, and
Homebrew/core submissions must stay human-owned.

Do not publish a channel until the channel passes the package gate in
`docs/release-readiness.md`: install, upgrade, launch, checksum, and rollback or
yank behavior must be validated from the public repository, not only from local
files.

## Agent Boundaries

Packaging policy changes quickly, so re-check the target repository's current
contribution rules before submission.

- Agents may prepare local packaging files, run checks, branches, and demo
  assets for human review.
- Agents must not open official Debian, Ubuntu, Fedora, or Homebrew/core package
  submissions unless the target project explicitly allows that workflow.
- Agents must not respond to maintainer review, sponsor questions, or policy
  objections. A human maintainer must own those conversations.
- If AI assistance was material, disclose it wherever the target repository asks
  for contribution disclosure.
- Do not add AI-generated commit trailers such as `Co-authored-by` unless the
  receiving project explicitly asks for them.

## Package Names

Keep the install story explicit so CLI and desktop behavior stay in line:

- `archductor`: CLI plus the `archcar` daemon. This is the headless package and
  the package Homebrew installs today.
- `archductor-desktop`: Electron desktop app plus bundled sidecars. This is the
  GUI package for APT/DNF repositories.

If public docs say "install Archductor desktop", the package-manager command
must install `archductor-desktop` or otherwise clearly say it is CLI-only.

## Required Release Inputs

For a release `vX.Y.Z`, collect:

- tag `vX.Y.Z` on `perceo-ai/conductor-arch`
- GitHub release containing CLI `.deb`, CLI `.rpm`, desktop `.deb`, desktop
  `.rpm`, AppImage, source tarball, and checksums
- `dist/SHA256SUMS` from the Linux release build
- `desktop/release/SHA256SUMS` generated for the Electron desktop `.deb` and
  `.rpm` artifacts before publishing them to package repositories
- Perceo package-signing key fingerprint and public key URL
- public base URLs:
  - APT: `https://packages.perceo.ai/apt`
  - DNF: `https://packages.perceo.ai/rpm`
  - Homebrew tap: `https://github.com/perceo-ai/homebrew-tap`

Before publishing, run:

```bash
scripts/check-public-repository-listing.sh --version X.Y.Z --metadata-only
scripts/check-public-repository-listing.sh --version X.Y.Z --require-artifacts
```

The metadata check works before a release build exists. The artifact check is
for the release host after CI or local Linux packaging has produced the CLI and
Electron desktop `.deb`/`.rpm` files.

## APT Repository

Use a Perceo-owned repository for first public listing. APT clients should use a
repository-scoped keyring via `signed-by`, not a global trusted key.

Client source template: `packaging/apt/archductor.sources`.

Recommended layout:

```text
https://packages.perceo.ai/apt/
  archductor-archive-keyring.gpg
  dists/stable/InRelease
  dists/stable/Release
  dists/stable/Release.gpg
  pool/main/a/archductor/
```

Required packages:

- CLI package from `nfpm.yaml`: `archductor_<version>_amd64.deb`
- desktop package from `desktop/electron-builder.yml`:
  `archductor-desktop_<version>_amd64.deb`

Human validation:

```bash
curl -fsSLo /tmp/archductor-archive-keyring.gpg \
  https://packages.perceo.ai/apt/archductor-archive-keyring.gpg
sudo install -Dm644 /tmp/archductor-archive-keyring.gpg \
  /usr/share/keyrings/archductor-archive-keyring.gpg
echo "deb [arch=amd64 signed-by=/usr/share/keyrings/archductor-archive-keyring.gpg] https://packages.perceo.ai/apt stable main" \
  | sudo tee /etc/apt/sources.list.d/archductor.list
sudo apt update
sudo apt install archductor archductor-desktop
archductor doctor
archductor archcar repositories
archductor archcar workspaces
xvfb-run -a sh -c 'archductor-desktop >/tmp/archductor-desktop.log 2>&1 & pid=$!; sleep 10; if ! kill -0 "$pid"; then cat /tmp/archductor-desktop.log; exit 1; fi; kill "$pid"; wait "$pid" || true'
sudo apt install --only-upgrade archductor archductor-desktop
sudo apt remove archductor-desktop archductor
```

Publication checklist:

- Sign the repository metadata with the Perceo APT key.
- Publish the binary public key at the repository root as
  `archductor-archive-keyring.gpg`.
- Verify `apt update` fetches `InRelease` without trust warnings.
- Verify install, actual desktop launch, sidecar RPCs, upgrade, removal, and
  reinstall on a fresh Debian or Ubuntu VM.
- Document rollback as publishing the previous version as the newest repository
  candidate or removing the bad version and regenerating signed metadata.

## DNF Repository

Use a Perceo-owned RPM repository for first public listing. DNF clients should
install a `.repo` file with `gpgcheck=1` and the Perceo RPM key.

Client repo template: `packaging/rpm/archductor.repo`.

Recommended layout:

```text
https://packages.perceo.ai/rpm/
  RPM-GPG-KEY-archductor
  archductor.repo
  x86_64/
    repodata/
    archductor-<version>-1.x86_64.rpm
    archductor-desktop-<version>.x86_64.rpm
```

Required packages:

- CLI package from `nfpm.yaml`: `archductor-<version>-1.x86_64.rpm`
- desktop package from `desktop/electron-builder.yml`:
  `archductor-desktop-<version>.x86_64.rpm`

Example repo file:

```ini
[archductor]
name=Archductor
baseurl=https://packages.perceo.ai/rpm/x86_64
enabled=1
gpgcheck=1
repo_gpgcheck=1
gpgkey=https://packages.perceo.ai/rpm/RPM-GPG-KEY-archductor
```

Human validation:

```bash
sudo curl -fsSL -o /etc/yum.repos.d/archductor.repo \
  https://packages.perceo.ai/rpm/archductor.repo
sudo dnf makecache --repo archductor
sudo dnf install archductor archductor-desktop
archductor doctor
archductor archcar repositories
archductor archcar workspaces
xvfb-run -a sh -c 'archductor-desktop >/tmp/archductor-desktop.log 2>&1 & pid=$!; sleep 10; if ! kill -0 "$pid"; then cat /tmp/archductor-desktop.log; exit 1; fi; kill "$pid"; wait "$pid" || true'
sudo dnf upgrade archductor archductor-desktop
sudo dnf remove archductor-desktop archductor
```

Publication checklist:

- Sign RPM packages with the Perceo RPM key.
- Generate or update repository metadata with `createrepo_c`.
- Sign repository metadata when `repo_gpgcheck=1` is advertised.
- Verify install, actual desktop launch, sidecar RPCs, upgrade, removal, and
  reinstall on fresh Fedora and openSUSE VMs before advertising support for both
  `dnf` and `zypper`.
- Document rollback as publishing a higher-release rebuild of the previous
  version or removing the bad package and regenerating signed metadata.

## Homebrew Tap

The source formula lives at `packaging/homebrew/Formula/archductor.rb`; the
tag-driven publish workflow copies it to `perceo-ai/homebrew-tap` when
`HOMEBREW_TAP_TOKEN` is configured.

Before publishing a formula update:

```bash
scripts/update-homebrew-formula.sh X.Y.Z <source-tarball-sha256>
brew audit --strict --online --formula packaging/homebrew/Formula/archductor.rb
brew install --build-from-source packaging/homebrew/Formula/archductor.rb
brew test archductor
archductor doctor
```

The current formula is intentionally CLI/headless: it installs `archductor` and
`archcar`. Do not imply it installs the Electron desktop app. A desktop Homebrew
install would need a separate cask or another reviewed distribution decision.

## Official Repository Submissions

Official distro repositories are a later, human-owned track. Prepare these only
after the Perceo-owned repos pass the public channel gate:

- Debian/Ubuntu: a human maintainer prepares Debian packaging, source package
  metadata, copyright/licensing review, and sponsor or maintainer upload path.
- Fedora: a human maintainer prepares a Fedora-compliant spec, license review,
  bundled dependency review, package review bug, and ongoing maintainership.
- Homebrew/core: a human contributor submits only if the formula satisfies
  Homebrew's current acceptable-formula criteria and the CLI/headless package is
  useful without the desktop app.

Drafts for the human-owned track live in `packaging/official/`:

- `debian-itp.md`
- `fedora-package-review.md`
- `homebrew-core-pr.md`

Agents can draft packaging files and checklists for those humans, but the
submission, review responses, and maintainer commitments must be made by the
human contributor.
