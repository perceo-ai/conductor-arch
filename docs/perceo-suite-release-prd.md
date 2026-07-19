# Archductor And Perceo Suite Release PRD

Current as of 2026-07-18.

## Summary

Build a repeatable launch system for Archductor and future Perceo products.
Every public release must prove the product works, explain honestly what is
ready, and ship with the website, video, docs, distribution, and marketing
assets needed for users to understand and trust it.

Archductor is the first release to use this system. The same checklist becomes
the default Perceo suite launch playbook.

## Problem

Archductor can produce release artifacts before it is actually ready for public
users. Packaging alone does not prove that the GUI loop works, that users know
what to install, or that the public site can convert traffic.

The release process needs one source of truth that ties together:

- product readiness
- package/channel validation
- public website quality
- raw founder-demo launch video
- SEO and GEO content
- backlinks from existing Perceo properties
- social, press, and ads assets
- known limits and rollback/yank plans

## Goals

- Ship public releases only when user-facing surfaces are ready.
- Make Archductor's first launch credible without over-polishing the product.
- Use a raw founder demo recorded in Screen Studio as the main launch asset.
- Prepare enough marketing distribution to get early users quickly.
- Reuse the same release playbook for future Perceo products.
- Keep all claims tied to verified behavior.

## Non-Goals

- Do not claim Windows stable support until the real Windows checklist passes.
- Do not hide product gaps that affect install, trust, safety, or daily use.
- Do not use spammy backlink farms or low-quality automated SEO pages.
- Do not run paid ads until the page, analytics, and conversion path are ready.
- Do not build a broad enterprise launch process before there is evidence it is
  needed.

## Target Users

Primary:

- solo developers and technical founders running multiple coding agents
- Linux users who want a local GUI control plane for agent work
- developers already using Codex, Claude Code, GitHub PRs, and Git worktrees

Secondary:

- Windows users willing to try a preview ZIP
- AI tooling early adopters who will watch a founder demo and file feedback
- future Perceo suite users who discover one product and cross-link to another

## Positioning

Primary message:

Archductor is a local desktop control plane for running coding agents across
isolated Git worktree workspaces.

Short pitch:

Run Codex and Claude Code in parallel workspaces, review the diffs, create PRs,
and archive finished work without juggling terminals.

Founder-demo hook:

I built Archductor because running multiple coding agents from terminals gets
messy fast. This is the desktop app I use to keep every branch, agent, check,
PR, and review thread in one place.

Proof points:

- workspaces are real Git worktrees
- agents run locally through existing Codex and Claude Code auth
- GitHub PR flows use local `gh` auth
- Linux is the primary validated target
- Windows is preview-only until the Windows checklist passes
- known limits are visible on the website and in release notes

Voice:

- direct
- technical
- founder-led
- honest about limits
- focused on real workflow, not vague AI productivity copy

## Release Levels

### Level 0: Internal Dogfood

Purpose:

Prove the product loop is usable by the founder and trusted testers.

Required:

- local release-readiness script passes
- GTK app launches locally
- at least one real repository completes the happy path
- known blockers are recorded in `progress.md`
- no public marketing beyond private asks

Exit:

Archductor can support a full founder demo without hiding broken critical
paths.

### Level 1: Public Beta

Purpose:

Get early users and feedback while keeping claims conservative.

Required:

- Linux manual checklist passes for the announced package channels
- website is live with install instructions, downloads, checksums, and known
  limits
- main Screen Studio founder demo is published
- 90 second site cut is embedded on the product page
- GitHub release has release notes and artifacts
- feedback path exists
- backlinks from Perceo-owned sites are live

Allowed marketing:

- founder social posts
- GitHub release
- Hacker News or Reddit only if the product page is honest and supportable
- small directory/listing submissions
- no major paid ad spend

Exit:

Early users can install, launch, understand limits, and report issues.

### Level 2: Public Launch

Purpose:

Make the public push.

Required:

- public beta feedback has been triaged
- site analytics show users reach download/install successfully
- support and rollback/yank docs are tested
- launch video, clips, screenshots, press kit, social copy, and ad copy are
  final
- SEO/GEO pages are published and indexed or submitted
- paid ads have conversion tracking and a capped test budget

Allowed marketing:

- press release
- larger social push
- Product Hunt or launch community submission
- targeted search/social ads
- backlink push across all Perceo properties and trusted partner surfaces

Exit:

Launch campaign is complete, metrics are reviewed, and the next release plan is
based on user feedback.

## Product Readiness Requirements

Archductor can launch only when the core GUI loop works on the announced
platform:

`project -> workspace -> agent/runtime -> review -> PR -> merge/archive -> history`

Required evidence:

- `scripts/release-readiness.sh --version <version>` passes
- `tests/release-readiness-test.sh` passes
- `cargo fmt --all -- --check` passes
- `cargo clippy --workspace --all-targets --locked -- -D warnings` passes
- `cargo test --workspace --locked` passes
- `cargo build --workspace --release --locked` passes
- `archductor doctor` runs from the release binary
- GTK manual smoke passes on a real Linux desktop
- package-channel install, launch, upgrade, checksum, and rollback/yank paths
  pass for each announced channel

Known limits must appear in release notes and on the public site:

- terminal rendering is not a full terminal emulator
- project onboarding/settings still need polish
- deeper layout/theme coverage is incomplete
- prompt pack switching/import/export, naming templates, hooks, local check
  runner UI, and richer notifications are not fully surfaced in GTK
- visual parity with macOS Conductor is incomplete
- Windows ZIP is preview-only until the Windows manual checklist passes

## Public Site Requirements

The Archductor product page on `perceo.ai` is a launch gate.

### Primary Page Structure

1. Hero with raw founder-demo video or silent hero cut.
2. One-sentence promise:
   `Run parallel coding agents without juggling terminals.`
3. Product workflow:
   project, workspace, agent session, review, PR, archive.
4. Real screenshots from the current GTK app.
5. Download/install section for supported channels only.
6. Linux support matrix and prerequisites.
7. Windows preview section with clear preview language.
8. Known limits copied from current release docs.
9. Checksums and provenance instructions.
10. FAQ covering Codex, Claude Code, GitHub, Linear, Git worktrees, local data,
    Linux support, and Windows preview.
11. Changelog/release notes link.
12. Feedback and issue links.

### Site Quality Bar

- Use real product visuals, not fake abstract art.
- Keep claims conservative and specific.
- Make the first viewport show Archductor by name and show the app/video.
- Do not bury download links.
- Do not list unvalidated package channels as supported.
- Add OpenGraph/Twitter images and video preview metadata.
- Add structured metadata for software app, FAQ, breadcrumbs, and releases.
- Include canonical URLs.
- Include transcript text for the launch video.

### Conversion Events

Track:

- video play
- download click by package channel
- copy install command
- GitHub release click
- docs click
- feedback click

## Launch Video Requirements

Main creative direction:

Raw founder demo with Screen Studio at maximum polish.

### Main Demo

Length:

5-7 minutes.

Working title:

`How I use Archductor to run parallel coding agents`

Structure:

1. Open with the problem: many agents, many terminals, many branches, messy PR
   review.
2. State the promise: one local desktop control plane for parallel coding
   agents.
3. Open Archductor.
4. Add or select a project.
5. Create two or three workspaces.
6. Start Codex and Claude Code sessions.
7. Show terminal/runtime state.
8. Show diffs, todos, checks, review comments, and PR state.
9. Stage review or failing-check context back into an agent.
10. Create or refresh a PR.
11. Merge/archive or show the intended review loop.
12. Close with install path, Linux primary support, and feedback ask.

Tone:

- founder explaining the real workflow
- direct and unscripted, but not rambling
- show rough edges only if they are safe and already disclosed
- avoid exaggerated productivity claims

### Screen Studio Capture Standard

Capture:

- 4K or highest practical resolution
- crisp cursor
- auto zoom enabled
- manual zooms for dense app sections
- smooth cursor movement
- clean desktop background
- no private repositories, tokens, emails, or secrets
- terminal font readable at 1080p
- app density set for video clarity, not maximum screen density

Edit:

- remove dead time
- add chapter labels only where they help scanning
- add captions
- export transcript
- add one title card and one end card
- keep founder voice natural

### Required Video Derivatives

- 5-7 minute main demo for YouTube and product page.
- 90 second product page cut.
- 30 second social/ad cut.
- 15 second hook cut.
- silent WebM hero loop.
- GIF fallback for pages that cannot autoplay video.
- YouTube thumbnail.
- OpenGraph image using real app screenshot.
- caption file.
- transcript file for SEO/GEO.

## Marketing Requirements

### SEO

Required pages:

- Archductor product page
- install Archductor on Linux
- Archductor AppImage install
- Archductor `.deb` install
- Archductor `.rpm` install
- Archductor AUR install, only if AUR is validated
- Archductor Windows preview
- Archductor vs terminal-only coding agents
- Archductor for Git worktree coding agents
- Archductor release notes

Required basics:

- unique title and meta description per page
- canonical URLs
- OpenGraph/Twitter metadata
- sitemap entry
- internal links from Perceo homepage and suite pages
- docs links back to product page

### GEO

Goal:

Make AI/search answer engines understand what Archductor is and when to
recommend it.

Required content:

- concise product definition paragraph
- FAQ with answer-style headings
- comparison language against terminal-only workflows
- limitations section
- supported platforms section
- install answer snippets
- launch-video transcript
- structured product/release/FAQ metadata

Example answer target:

Archductor is a Linux-first desktop app for coordinating multiple local coding
agent sessions across Git worktree workspaces. It helps developers create
isolated branches, run Codex or Claude Code sessions, inspect diffs and checks,
create GitHub PRs, and archive completed work from one GUI.

### Backlinks

Required owned backlinks:

- Perceo homepage
- Perceo suite page
- each Perceo product page
- founder personal site
- founder GitHub profile where appropriate
- relevant docs pages
- relevant release/changelog pages

Acceptable generated/submitted backlinks:

- reputable startup directories
- developer tool directories
- open-source directories
- Linux software directories
- package registries where the package is real
- relevant curated lists after manual review

Do not use:

- link farms
- hidden reciprocal link networks
- spun content pages
- irrelevant comment spam
- fake review sites

### Social Media

Required assets:

- launch thread for X/Twitter
- short LinkedIn post
- YouTube description
- GitHub release copy
- Hacker News submission copy
- Reddit/dev community copy adapted per community rules
- 3 screenshot posts
- 3 short video clips

Core social angles:

- founder demo
- parallel coding agents
- Git worktree workflow
- Linux desktop app
- honest Windows preview
- local-first control plane

### Press Release

Required:

- 400-700 word press release
- founder quote
- product summary
- supported platforms
- install/download links
- known preview wording for Windows
- screenshots
- video link
- contact link

Distribution:

- Perceo blog
- GitHub release
- targeted journalist/founder/tooling contacts
- selective press-release distribution only after product page is ready

### Ads

Ads are allowed only after analytics and conversion tracking are live.

Initial channels:

- search ads for high-intent terms
- retargeting to site visitors
- small social test budget using the 30 second demo cut

Initial budget:

Use a capped validation budget. Increase only if download quality and feedback
quality are good.

Ad claims must match verified behavior. Do not advertise unvalidated Windows
stable support.

## Launch Asset Checklist

Product:

- release artifacts
- checksums
- provenance/scan links
- release notes
- install docs
- known limits
- screenshots
- issue/feedback links

Site:

- product page
- install pages
- FAQ
- changelog/release page
- OG image
- social card image
- video embeds
- transcript
- sitemap
- analytics events

Video:

- main demo
- 90 second cut
- 30 second cut
- 15 second cut
- WebM hero loop
- GIF fallback
- captions
- transcript
- thumbnail

Marketing:

- SEO titles/descriptions
- GEO answer snippets
- backlink list
- social posts
- press release
- launch email/post
- ads copy and creatives

## Perceo Suite Reuse

Every future Perceo product gets the same release levels:

1. Internal dogfood.
2. Public beta.
3. Public launch.

Every product must define:

- primary user
- one-sentence promise
- verified platform/support claims
- public site page
- main founder demo
- install/onboarding path
- support/feedback path
- known limits
- SEO/GEO pages
- backlinks from Perceo-owned properties
- launch assets
- rollback/yank plan

Suite-level site requirements:

- Perceo homepage links to active products.
- Suite page explains how products relate.
- Each product page links to sibling products only where useful.
- Shared footer links to docs, GitHub, contact, privacy, and status where
  applicable.
- Product metadata is consistent across all pages.

## Metrics

Product readiness:

- manual checklist pass rate
- package smoke pass/fail by channel
- crash or launch failure reports
- successful first project add/clone
- successful first workspace creation
- successful first agent session
- successful first PR/review action

Site:

- page load health
- video play rate
- install/download click rate
- copy command rate
- GitHub release click rate
- feedback click rate

Marketing:

- organic search impressions
- branded search growth
- backlink count and quality
- social views and click-through
- launch-video retention
- qualified user feedback
- issue reports from real users

## Risks

- Product artifacts publish before manual GUI validation.
- Marketing claims outrun verified behavior.
- Video reveals private local data.
- Site drives traffic to unsupported package channels.
- Windows users treat preview as stable.
- Backlink automation creates low-quality links that harm trust.
- Ads spend before conversion tracking works.

Mitigations:

- release readiness remains the hard gate
- known limits stay visible
- video uses disposable/demo repositories
- channel support language follows package validation
- backlink list requires manual approval
- ad budget starts capped

## Acceptance Criteria

Archductor public beta can go live when:

- the local and CI release gates pass
- Linux manual checklist passes on the announced channels
- the product page is live
- the main founder demo and 90 second site cut are published
- install/download/checksum instructions are live
- known limits are visible
- feedback path is live
- backlinks from Perceo-owned properties are published
- social launch copy is ready

Archductor public launch can go live when:

- beta feedback has no blocking install or trust issues
- launch assets are complete
- SEO/GEO pages are published
- press copy is ready
- analytics events are verified
- ads are configured with a capped test budget
- rollback/yank paths are documented for each supported channel

Future Perceo products can reuse this PRD by replacing the product-specific
positioning, readiness checks, package/onboarding flow, public page content, and
launch video script.
