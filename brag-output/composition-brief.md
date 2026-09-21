# Hyperframes Composition Brief: Archductor

## Objective
Create a short launch-style brag video for Archductor.

## Output
- Composition directory: `brag-output/composition/`
- Rendered video: `brag-output/brag.mp4`
- Format: landscape — 1920x1080, 30fps
- Duration: 21.84s

## Source Material
- Project root: `/Users/kitts/conductor/workspaces/conductor-arch/columbia`
- Primary files read: `README.md`, `desktop/src/styles/theme/01-tokens.css`,
  `desktop/src/styles/neutral/01-tokens.css`, `desktop/src/pages/Dashboard.tsx`,
  `desktop/src/pages/ChatSurface.tsx`, `desktop/src/bridge/protocol/*`
- Product name: **Archductor**
- Tagline / strongest claim: *"A desktop control plane for running coding agents
  across isolated Git worktree workspaces."* The sharpest line on the page is the
  pain, not the pitch: *"context-switching between branches, stashes, and
  half-finished agent runs is where time goes to die."*
- Key UI moment to recreate: nothing is recreated. Four **real renders of the
  real components** were captured for this video by building the renderer
  (`cd desktop && npx vite build`) and stubbing the `window.archductor` preload
  bridge in headless Chromium — the project's own fake-bridge screenshot recipe.
  Capture script and output: `brag-output/shots/shoot.mjs`, run against a static
  server on the built `desktop/dist`. All four are 3200x1800 (16:9 at 2x):

  | Asset | Surface |
  | --- | --- |
  | `shots/01-dashboard.png` | Kanban board: Needs you / Ready / Running / Review / Archived, 9 workspaces |
  | `shots/02-chat.png` | A workspace: live Codex session timeline + Changes rail |
  | `shots/03-diff.png` | Syntax-highlighted Rust diff, review comment bar |
  | `shots/04-palette.png` | ⌘K command palette over a dimmed workspace |

  Copy these into `composition/assets/shots/`.
- Copy that must appear verbatim:
  - "Context-switching is where time goes to die."
  - "Archductor"
  - "a control plane for parallel coding agents"
  - "its own worktree" / "its own branch" / "its own agent"
  - "Codex and Claude Code run inside the workspace."
  - "Review the diff. Open the PR. Archive the worktree."
  - "Local-first. Linux-first. SSH remote, no open port."
  - "paru -S archductor"

## Creative Direction
- Tone preset: **polished**
- Creative direction: *a control-plane product film — restrained, dense,
  technical; the confidence is in the numbers on screen, not in the adjectives.*
- Interpretation: this is infrastructure for people who already know what a
  worktree is. Motion is short, eased, and mostly a camera move over real UI.
  No swooshes, no exclamation marks, no bounce easing, no gradient washes the
  product does not itself use. Cuts are hard and on the beat; within a scene the
  movement is a single slow punch or drift. Every reveal settles fast and then
  holds — the pacing comes from the cuts, never from flashing text.
- Angle: Archductor's whole argument is that parallel work should not cost you
  your working tree. So the film is the board first (nine things in flight,
  bucketed by what they need from you), then one workspace opened to show an
  agent mid-turn inside its own worktree, then the diff and the PR. The product
  is legible in three shots because the product is legible in three screens.
- Hook: 2.7s on black — the README's own line about where time goes to die,
  under a single gold hairline.
- Outro / punchline: the wordmark with that same hairline redrawn beneath it,
  then "Local-first. Linux-first. SSH remote, no open port." and the install
  command. The joke, such as it is, is that the recommended remote mode opens
  nothing at all.
- Avoid:
  - Generic SaaS language
  - Abstract filler visuals
  - Unrelated visual redesign
  - More than one accent colour in a frame — the app uses exactly one

## Visual Identity
Taken from `desktop/src/styles/theme/01-tokens.css` and `neutral/01-tokens.css`.

- Background: `#0f0f0f` (film base) / `#111111` (app base)
- Surface: `#171717`, raised `#1d1d1d`
- Hairline: `#292929`, strong `#3a3a3a`
- Text: `#f0f0f0` strong, `#d8d8d8` body, `#8a8a8a` muted
- Accent (the only one): `#d4a94f` gold
- Diff add / delete: `#6cc58a` / `#e06f6f`
- Display font: **Mona Sans**, falling back to Inter then the system stack —
  the app's own `--ui-font-sans`. Use a webfont only if one is available
  locally; otherwise Inter is the honest fallback and matches closely.
- Body / mono font: **Commit Mono**, falling back to JetBrains Mono then
  `ui-monospace` — the app's `--ui-font-mono`. All captions rendered in mono
  belong to this stack.
- Radius: 6px everywhere, matching `--ui-radius`.
- Visual references from the project: the five-column board; the gold left rail
  on a selected workspace row; `+642 −210` diff counts in green/red; the tool
  chips in the session timeline; the ⌘K palette's dimmed backdrop.

## Storyboard
Use the storyboard in `brag-output/brag-plan.md` as the creative contract. It
carries per-scene timings, beat locks, the readability table, and the exact
copy. Summary:

1. **Hook** — 2.73s — black; "Context-switching is where time goes to die." with a gold hairline drawing beneath it.
2. **Reveal** — 4.36s — the Kanban board settles from 1.06x; column headers and cards stagger in; name plate lower-left.
3. **Isolation** — 3.84s — punch to 1.55x on the Running column + sidebar; the three-segment mono caption builds.
4. **Agent working** — 3.80s — the chat timeline at 1.25x drifting to 1.32x; five tool chips reveal then hold.
5. **Review and ship** — 3.83s — the diff, static; green then red wash; the palette cross-dissolves in at 17.47s.
6. **Outro** — 3.28s — wordmark, hairline rhyme, claim line, install command; music fades out.

## Audio
- Audio role: **sparse professional accents over a low bed.** The music is a pad,
  not a groove; it should never be the reason a frame feels energetic.
- Audio arc: enters at low gain under the hook, sits flat and unobtrusive through
  the three highlights (no build, no drop), rings once on the outro cut, then
  fades to silence across the last second.
- Music: `happy-beats-business-moves-vol-12-by-ende-dot-app.mp3` — 109.96 BPM,
  the slowest of the five bundled beds, which is the only one that reads as
  restraint at low gain.
- Music treatment: low, roughly 0.16–0.20 gain. 0.6s fade-in from 0.00s. Hard
  fade-out 20.80s → 21.84s so the final bell rings over silence. No ducking
  (there is no voiceover). Let the outro SFX sit above the bed rather than
  raising the bed for the payoff.
- Music cue guidance: bundled preset at
  `<skill-dir>/assets/music/cues/happy-beats-business-moves-vol-12-by-ende-dot-app.music-cues.json`.
  Every scene boundary already sits on that grid (see the plan's cue table).
  Three strong-cue locks are planned — 8.74s, 10.93s, 17.47s — plus the 18.56s
  outro cut. The Scene 2 column wipe and the Scene 4 chip stagger are
  deliberately **off** the grid for readability; keep them that way.
- Audio-reactive treatment: **subtle.** Drive the gold hairline's glow and the
  frame vignette depth from music RMS so the dark frame breathes. Optionally let
  the Scene 2 name plate gain a touch of presence on bass. Nothing that scales
  text, strobes, or reads as a visualizer.
- Audio-coupled moments:
  - Scene 3 caption segments (7.64 / 8.19 / 8.74s) — beat-grid reveal, last one on a strong cue
  - Scene 4 cut (10.93s) — strong-cue scene transition
  - Scene 5 palette cross-dissolve (17.47s) — strong-cue reveal, one quiet click
  - Scene 6 outro (18.56 / 19.66 / 20.75s) — beat-grid landing of wordmark, claim, install chip
- SFX selection guidance: four cues total, all low. A deep soft bell under the
  hook; a soft impact on the board reveal; one quiet interface click on the
  palette dissolve; one resonant bell on the outro cut, allowed to ring under the
  music fade. Nothing at all over Scenes 3 and 4 — the camera move and the chips
  are already doing the work, and a polished tone earns more from the silence.
  Starting points, not a contract: `interface/bong_001.ogg`,
  `impact/impactSoft_medium_000.ogg`, `interface/click_001.ogg`,
  `impact/impactBell_heavy_000.ogg`. Re-pick after the animation exists.
- SFX analysis guidance: `<skill-dir>/assets/sfx/sfx-analysis.md` — prefer
  low high-frequency-risk files throughout; this tone has no room for a harsh one.
- Exact SFX choice: Hyperframes chooses filenames, timestamps, density, and
  volume based on the implemented animation.
- Audio files: copy the chosen music and any selected SFX into
  `brag-output/composition/assets/`.

## Hyperframes Instructions
Load the composition-building Hyperframes domain skills — `hyperframes-core`
(composition contract + `data-*` timing), `hyperframes-animation` (motion),
`hyperframes-creative` (design spec, beats, audio-reactive), `hyperframes-keyframes`
(seek-safe keyframes), and `hyperframes-cli` (lint/check/render). /brag is its own
workflow: do not enter the `hyperframes` entry-point intent interview and do not
route into its generic promo / launch-video workflow. Prefer native Hyperframes
conventions over anything in `/brag`.

Requirements:
- Show at least one real UI element from the source project. Four real renders
  are supplied; they are the spine of the film, not decoration.
- Keep all text readable in the final render (the plan's readability table is the
  floor, not a target).
- Keep the video within 15-25 seconds.
- Include the planned music/SFX layer.
- Treat `/brag` audio notes as guidance. Choose SFX after the visual animation exists.
- Treat music cue metadata as optional timing hints; ignore any cue that hurts
  readability, pacing, or the product story.
- Major reveals may move within ~0.15s of a strong cue; smaller entrances within
  ~0.10s of a beat. 1-3 strong locks total (four are planned; drop one if the
  edit feels metronomic).
- Honor the music fade-out and the ringing outro bell.
- Wire at least one visual element to per-frame audio data (see the audio-reactive
  guidance owned by `hyperframes-creative`). If extraction is unavailable, note it
  and skip rather than block the render.
- Use local assets only; never absolute paths in the composition HTML.
- Run `npx hyperframes check` before render — brag's single gate.
