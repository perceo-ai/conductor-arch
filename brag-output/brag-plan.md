# /brag plan — Archductor

Invocation: `/brag` (no flags). Defaults: landscape, music on, SFX on, no voice,
tone inferred, duration auto.

Output dir: `brag-output/` (did not exist before this run, so no timestamp suffix).

## 1. Inspection rubric

**1. What is the app?**
Archductor is a desktop control plane for running several coding agents in
parallel, each in its own isolated Git worktree, branch, and runtime — backed by
a Rust daemon (`archcar`) that the Electron UI, the `archductor` CLI, and MCP
clients are all just clients of.

**2. Funniest / most impressive claim**
Verbatim from the README, and it is the whole product thesis:

> "context-switching between branches, stashes, and half-finished agent runs is
> where time goes to die."

Runner-up, also verbatim and much sharper than typical infra marketing: the SSH
transport section's "The server needs no `--listen` at all" — the product's
recommended remote mode opens **no port and shares no secret**.

**3. Visual hook**
The near-monochrome charcoal shell (`#111111` base, `#171717` surfaces,
`#292929` hairlines) with exactly one accent — gold `#d4a94f` — and the
green/red diff pair `#6cc58a` / `#e06f6f` as the only other colour in the frame.
The strongest single composition is the **five-column Kanban dashboard**:
Needs you / Ready / Running / Review / Archived, nine workspace cards carrying
`+642 −210`, `2 agents`, `PR #118 open`.

**4. What to show from the actual UI**
Real renders of the real components, not mockups. Captured by building the
renderer (`vite build`) and stubbing `window.archductor` in headless Chromium
(the project's own fake-bridge recipe), at 1600×900 @2× = 3200×1800 (16:9):

| File | Surface |
| --- | --- |
| `shots/01-dashboard.png` | Kanban dashboard, 9 workspaces across 5 columns |
| `shots/02-chat.png` | Workspace: Codex session timeline + Changes rail |
| `shots/03-diff.png` | Side-by-side diff view, syntax-highlighted Rust |
| `shots/04-palette.png` | ⌘K command palette over a dimmed workspace |

**5. Shortest satisfying video**
~21s. The pain line needs a real hold, the dashboard needs time to be read as a
board (five columns is a lot of frame), and there are three genuine highlights.
15s would clip the board beat, which is the one that sells it.

**6. Tone**
Preset: **polished**.
Creative direction: *a control-plane product film — restrained, dense,
technical; the confidence is in the numbers on screen, not in the adjectives.*
This is infrastructure for people who already know what a worktree is. No
exclamation marks, no swooshes, no "revolutionise". Motion is short, eased, and
mostly a camera move over real UI.

**7. Audio**
Low, sparse music bed — one sustained pad, no drop, fading under the outro.
SFX are motion-matched and dry: a soft tick per card/line reveal, one low swell
on the dashboard reveal, one quiet resolve on the final wordmark. Nothing
percussive over the diff beat — that beat should feel like reading.

**8. Share caption (draft)**
"Nine branches in flight, one window. Archductor gives every task its own
worktree, its own agent, and its own PR — and the remote mode opens no port at
all."

**9. User flow worth showing**
entry → key action → result, as the app actually runs it:

1. **Entry:** the board — every task in flight, bucketed by what it needs from
   you. "Needs you" is its own column because an agent parked on a question is
   the only state that stops making progress until a human acts.
2. **Key action:** open one workspace — a Codex session is mid-turn inside its
   own worktree, tool chips streaming, the Changes rail counting up.
3. **Result:** the diff, reviewed in-app, then a PR created and the workspace
   archived. No stash, no branch switch, nothing else disturbed.

## 2. Design identity (carried into the composition brief)

| Role | Value |
| --- | --- |
| Background | `#0f0f0f` (deepest) / `#111111` (app base) |
| Surface | `#171717`, raised `#1d1d1d` |
| Hairline | `#292929`, strong `#3a3a3a` |
| Text | `#f0f0f0` strong, `#d8d8d8` body, `#8a8a8a` muted |
| Accent (single) | `#d4a94f` gold |
| Diff add / del | `#6cc58a` / `#e06f6f` |
| Display font | Mona Sans → Inter fallback |
| Mono font | Commit Mono → JetBrains Mono fallback |
| Radius | 6px, matching `--ui-radius` |

Rule: the accent appears at most once per scene, as the app itself uses it.

## 3. Storyboard

Format 1920×1080, 30fps. Total **21.84s**.

Track: `happy-beats-business-moves-vol-12-by-ende-dot-app.mp3` (109.96 BPM, the
slowest of the five bundled beds, held at low gain so it reads as a pad rather
than a groove). **Every scene boundary sits on that track's beat grid** — the
reading-time floor was checked first, then each boundary was moved to the
nearest grid point that still satisfied it.

### Scene 1 — Hook (0.00 → 2.73) · 2.73s
- Full-bleed `#0f0f0f`. No UI yet.
- Centred, Mona Sans 64px, `#f0f0f0`:
  **"Context-switching is where time goes to die."**
  Word-group fade-up, 0.45s in, settled by 0.55s, **held 2.18s** (7 words, floor
  2.10s). Verbatim from the project README.
- A single gold hairline (2px, `#d4a94f`) draws left-to-right beneath the line
  from 0.90s → 1.50s, then sits. This mark returns in Scene 6.
- SFX: `interface/bong_001.ogg` at 0.05s, low. Music enters at 0.00 at low gain.

### Scene 2 — Reveal (2.73 → 7.09) · 4.36s   `// beat-locked: 2.73s`
- Hard cut on the beat. `shots/01-dashboard.png` fills frame at 1.06× scale,
  easing to 1.00 over 1.2s — a slow settle, not a whoosh.
- The five column headers wipe in 80ms apart from 2.88s; the nine workspace
  cards fade up behind them on a 60ms stagger. Natural timing, not beat-snapped:
  at 0.545s per beat a five-item grid would eat 2.7s of a 4.36s scene.
- Lower-left plate (`#171717` at 92%, 1px `#292929` hairline) enters 3.82s
  `// beat-grid`, held 3.27s:
  **Archductor** (28px Mona Sans, `#f0f0f0`)
  *a control plane for parallel coding agents* (17px, `#8a8a8a`) — 7 words.
- SFX: `impact/impactSoft_medium_000.ogg` at 2.73s, soft.

### Scene 3 — Highlight 1: isolation (7.09 → 10.93) · 3.84s
- Same frame, no cut: keyframe punch from the whole board to the **Running
  column plus the sidebar**, 1.00× → 1.55×, 1.0s ease. The only gold in frame is
  the app's own — the selected workspace's left rail.
- Caption rises bottom-centre, 20px mono `#d8d8d8`, in three segments
  `// beat-grid: 7.64s, 8.19s, 8.74s`:
  **`its own worktree`** · **`its own branch`** · **`its own agent`**
  `// beat-locked: 8.74s` (strong cue, 0.99) lands the last segment.
  The full line holds 1.98s after the third segment, and the first has been on
  screen 3.3s by then — progressive reveal, full set held afterward.
- SFX: none. The scene is a camera move; sound here would be decoration.

### Scene 4 — Highlight 2: the agent working (10.93 → 14.73) · 3.80s
`// beat-locked: 10.93s` (strong cue, 0.97)
- Cut to `shots/02-chat.png`, already punched to 1.25× on the session timeline,
  drifting to 1.32× across the scene (~5% Ken Burns).
- The five tool chips (`Ran cargo test …`, `Read …transport.rs`,
  `Edited …ssh.rs`, `Edited …remote.rs`, `Ran cargo clippy …`) reveal
  top-to-bottom 140ms apart, 11.05s → 11.61s, then hold as a set. Deliberately
  faster than the beat grid: five beats would run past the scene.
- Caption plate top-right at 11.90s, held 2.83s:
  **Codex and Claude Code run inside the workspace.** (7 words)
- SFX: none — the chips are small and the next payoff is two scenes away.

### Scene 5 — Highlight 3: review and ship (14.73 → 18.56) · 3.83s
- Cut to `shots/03-diff.png` at 1.18×, **static**. No camera move: this beat is
  reading.
- The added block's green wash (`#6cc58a` at low alpha) sweeps top-to-bottom
  over 0.5s from 14.83s; the deleted lines' red wash (`#e06f6f`) at 15.40s.
- Caption bottom-left at 15.20s:
  **Review the diff. Open the PR. Archive the worktree.** (9 words)
  It persists across the dissolve below and holds until 18.30s — 3.10s total.
- At 17.47s `// beat-locked: 17.47s` (strong cue, 0.99) `shots/04-palette.png`
  cross-dissolves in over 0.35s and holds to the cut — the ⌘K list of all nine
  workspaces, the proof of "one window".
- SFX: `interface/click_001.ogg` at 17.47s, quiet, on the palette dissolve.
  Nothing over the diff washes.

### Scene 6 — Outro (18.56 → 21.84) · 3.28s
`// beat-locked: 18.56s` (strong cue, 0.99)
- Cut to `#0f0f0f`. Three elements land on consecutive strong grid points
  `// beat-grid: 18.56s, 19.66s, 20.75s`:
  1. **Archductor** — 72px Mona Sans `#f0f0f0`, centre, with the Scene 1 gold
     hairline redrawing beneath it. The rhyme that closes the film.
  2. **Local-first. Linux-first. SSH remote, no open port.** — 20px `#8a8a8a`,
     7 words, held 2.18s.
  3. **`paru -S archductor`** — mono 18px `#d8d8d8` on a `#171717` chip, held
     1.09s.
- Music fades to silence across 20.80s → 21.84s.
- SFX: `impact/impactBell_heavy_000.ogg` at 18.56s, soft, allowed to ring under
  the fade.

### Timing check
2.73 + 4.36 + 3.84 + 3.80 + 3.83 + 3.28 = **21.84s** — inside the 15–25s law.

### Readability check (0.3s per word after settling; ~0.8s floor for a label)
| Scene | Words | Hold | Floor | |
| --- | --- | --- | --- | --- |
| 1 hook | 7 | 2.18s | 2.10s | ok |
| 2 plate | 7 | 3.27s | 2.10s | ok |
| 3 caption | 9 | 1.98s full set, 3.3s for the first segment | progressive | ok |
| 4 caption | 7 | 2.83s | 2.10s | ok |
| 5 caption | 9 | 3.10s | 2.70s | ok |
| 6 subline | 7 | 2.18s | 2.10s | ok |
| 6 install chip | label | 1.09s | 0.80s | ok |

## 4. Music cue guidance

Cue preset read from
`<skill-dir>/assets/music/cues/happy-beats-business-moves-vol-12-by-ende-dot-app.music-cues.json`
(109.96 BPM; grid 0.56, 1.09, 1.64, 2.19, 2.73, 3.27, 3.82, 4.39, 4.91, 5.34,
6.00, 6.56, 7.09, 7.64, 8.19, 8.74, 9.29, 9.83, 10.37, 10.93, 11.46, 12.02,
12.55, 13.11, 13.64, 14.20, 14.73, 15.29, 15.84, 16.38, 16.93, 17.47, 18.02,
18.56, 19.10, 19.66, 20.19, 20.75, 21.28, 21.84 …).

Strong cues used, three locks plus the outro grid:

| Time | Strength | Locked to |
| --- | --- | --- |
| 8.74s | 0.99 | last caption segment, Scene 3 |
| 10.93s | 0.97 | cut into Scene 4 |
| 17.47s | 0.99 | palette cross-dissolve, Scene 5 |
| 18.56s | 0.99 | cut into the outro |

Cue metadata is **timing guidance only**. The scene boundaries were set by
reading time first and only then nudged onto the grid; anything that would have
cost legibility (the Scene 2 column wipe, the Scene 4 chip stagger) stays on
natural timing and is marked as such above.

Audio-reactive treatment: **subtle**. Drive the gold hairline's glow and the
frame vignette's depth from music RMS so the dark frame breathes. No waveform,
equalizer, particle, or strobe treatment — the tone is restraint.
