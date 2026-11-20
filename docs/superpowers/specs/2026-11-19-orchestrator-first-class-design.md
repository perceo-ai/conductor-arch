# Orchestrator as a first-class concept

Design doc. Status: awaiting approval. Date: 2026-11-19. Reviewed once by a fresh builder;
its factual corrections and the questions it raised are folded in.

## Intent and why

Archductor runs many coding agents in parallel across isolated workspaces. It
does not help the human keep them moving. Today the owner of this repository
supplies that layer by hand: they open a Claude Code terminal and instruct it to
manage their chats through the `archductor` CLI and MCP server. That hand-rolled
orchestrator earns its keep by doing two things:

1. Giving them **one place for total review** — everything that wants their
   attention, across every workspace.
2. Making sure **all their agents are hard at work** — nothing sitting idle,
   nothing stuck, tasks actually driven to completion rather than merely started.

The request is to make that layer a first-class concept in the product, with
proactive notifications, without turning Archductor into a general automation
engine. In the user's words: *"I want it to be AI driven so that tasks are
actually driven to completion, I have one space to view what needs attention,
one agent to get them that attention."*

The identity question — does this dilute what Archductor is? — resolves cleanly.
Archductor's claim is a local control plane for parallel coding agents. A control
plane that cannot tell you which of your twelve agents is stuck is an incomplete
control plane, not a different product. The orchestrator is the missing half of
the existing promise, not a new one.

## Goals

- One surface, above all projects, that shows what needs the human's attention
  right now across every project and workspace, ranked, with items that leave
  when handled. Reachable on desktop, the CLI, and iOS.
- One orchestrator agent, also above all projects, that holds the human's
  standing instructions, reacts to what happens in the daemon, and acts to drive
  work to completion — prompting stalled chats, starting queued work, filling
  idle lanes.
- The human can talk to that orchestrator directly, in its own chat, and it
  reports back there.
- Proactive notification when something genuinely needs them, on the surfaces
  that already deliver notifications (desktop and iOS), with a tap landing on
  the attention item or the orchestrator chat.
- The attention surface is correct and useful **with the orchestrator turned
  off**. Watching is not AI work.
- CLI and Electron desktop reach parity on everything user-visible here.

## Non-goals

- A general workflow/automation engine, a rules DSL, or user-authored triggers.
  `crates/core/src/background_tasks.rs` already states this boundary in its
  module docs and that boundary holds.
- Replacing the per-workspace surfaces. The Summary, Checks, Changes and PR tabs
  stay exactly as they are; the attention surface links into them.
- Multi-user or team coordination. One human, their machine, their agents.
- Building on the existing workspace `tasks` model as the orchestrator's input.
  The user reports tasks are "not really 100% used right now", so tasks are
  something the orchestrator *writes* so its intent is legible, not what it
  reads.

## Anti-goals

Things that would make this a failure even if it technically worked:

- **An orchestrator that is expensive to leave running.** If it burns a turn per
  daemon event it will be switched off within a day, and then the feature does
  not exist.
- **An orchestrator that surprises the human.** Work it invents, pull requests
  it opens unasked, merges, pushes, or archived workspaces. Trust lost once here
  is not recovered.
- **An attention surface that is another inbox to groom.** If items do not leave
  on their own when the underlying thing is handled, it becomes a second chore.
- **A second source of truth.** The surface must derive from daemon state, never
  accumulate its own parallel copy of what is happening.
- **Watching that dies with the AI.** If the lists are only correct while an
  agent is running, the product is worse than today.

## Constraints found in the codebase

Recon findings that shape the build. These are load-bearing.

- **The event bus already exists and is detailed.** `ArchcarEvent` in
  `crates/core/src/archcar/protocol.rs` carries `TurnCompleted` (with
  `duration_ms`), `SessionExited`, `SessionError`, `ProviderInteractionRequested`
  /`Resolved`, `ChatPlanUpdated`, `ChatQueueUpdated`, `SummaryUpdated`,
  `BackgroundTaskUpdated`. `AgentSessionState` already distinguishes an agent
  mid-turn from one parked on a question (`waiting_for_input`). No new sensing
  layer is needed for the first version.
- **Notification delivery is built.** `crates/core/src/notifications.rs` maps
  events to notifications (`event_notification`) and delivers to registered
  devices including iOS via APNs; the desktop has
  `desktop/src/lib/eventNotifications.ts` and `desktop/src/store/toasts.ts`.
  Reuse, do not rebuild.
- **An all-scope MCP role already exists; the obstacle is delivery, not the
  guard.** Ordinary sessions are scoped by the `ARCHDUCTOR_WORKSPACE` env var and
  refused cross-workspace action (*"this session belongs to workspace `X`, so it
  cannot act on `Y`"*), which was hit live during this design conversation.
  But `McpProfile::Full` in `crates/core/src/mcp_server.rs` is already the
  unscoped surface, documented as what an external client drives across every
  workspace, and it honours caller-supplied `workspace`/`thread_id`. The guard
  needs no widening. What is missing is a way to hand *one session* a different
  profile: registration in `crates/core/src/mcp.rs` is device-wide and user-scope
  with one fixed `--profile` per client.
- **The daemon already spawns and drives agents headlessly.**
  `background_tasks.rs` runs prompt → workspace → agent → checks → summary → PR
  as an idempotent state machine the daemon ticks, and already supports more
  than one agent per task. The orchestrator should drive this machine rather
  than grow a second way to run an agent.
- **A cross-workspace triage view partly exists.** `desktop/src/pages/Dashboard.tsx`
  buckets workspaces into blocked/ready/running/review/archived, where
  `blocked` means `awaitingInput`. It is organised by workspace, not by what
  wants attention, and it is not above the project level.
- **Agent activity is half-modelled already.** `ProcessStatus` is only
  Running/Stopped/Exited, but `crates/core/src/agent_status.rs` already derives
  `AgentActivity` — Working / AwaitingInput / Finished / Failed / Stopped — from
  the provider stream and daemon liveness, for `archductor status`. Lane state
  should extend that one notion and put it on the event bus, not introduce a
  parallel one. What is genuinely missing is *stalled*: an agent running but
  making no observable progress.
- **Surface parity is a project rule.** `CLAUDE.md` and `claude/CLAUDE.md`
  require user-visible behaviour to land in both the CLI and the Electron app,
  or the missing side to be reported as incomplete.

## Approaches considered

**A. The orchestrator is just a privileged chat.** A long-lived agent session
with the archductor MCP attached; the daemon injects every event into it as a
turn; it acts through MCP tools, and its transcript is the record. Almost no new
Rust.
*Rejected.* It costs a turn per event, its context grows without bound, its
behaviour is unreproducible, and — decisively — the watching dies when it is
off, which is the stated anti-goal. A chat parked in one project also cannot see
across projects, which the user explicitly requires.

**B. Reactors in the daemon.** Built-in rules in Rust: event → condition →
action, with an agent called only where reading is needed. Deterministic,
testable, free to run.
*Rejected as the whole answer.* It is a rules engine. Standing instructions in
the user's own words have nowhere to live, every new instinct is a code change,
and nothing drives a task to completion — the explicit goal.

**C. Daemon reflexes plus one global orchestrator agent on a leash. — CHOSEN.**
The daemon owns the cheap, instant, always-on half: detecting idle and stalled
lanes, mapping events to notifications, and maintaining the ranked attention
queue. Those are plain Rust rules, they are testable, they cost nothing, and
they are correct while no AI is running. On top sits exactly one long-lived
orchestrator agent, above all projects, holding the user's standing
instructions. The daemon debounces and batches events into a short digest and
wakes the orchestrator with it; the orchestrator judges and acts, and its own
chat is where it reports and where the user talks to it.

Chosen because the reflexes must be instant and alive with the AI off — they
*are* the attention surface, and it stands on its own — while the agent is the
only thing that can read context and act on instructions given in prose. The
leash (debounce plus batch) is the difference between an orchestrator left
running and one switched off after the first token bill.

The user picked this shape, and specified: AI-driven, global across all
projects, one attention space, one orchestrator agent with its own chat.

## The design

### Scope and placement

The orchestrator and the attention surface live **above projects**. Neither is a
child of a project, a repository, or a workspace. In the desktop app they are a
top-level destination alongside the existing dashboard; in the CLI they are
top-level commands that take no workspace argument.

### Part 1 — Attention queue (daemon, no AI)

Core maintains a ranked, cross-project list of things wanting the human. Each
item is derived from daemon state, carries where it came from, and **clears
itself** when the underlying condition clears. Item kinds for the first version,
each already observable from existing events and stores:

- an agent asked a question (`waiting_for_input`, `ProviderInteractionRequested`)
- checks failed
- a diff is complete and unread by the human
- new PR review comments or a merge blocker
- a session errored or exited unexpectedly
- a background task reached a terminal state
- a lane is idle, or a session looks stalled

Ranking is computed in core so every surface shows the same order. Clearing is
derived, not stored as read/unread bookkeeping the human has to maintain.

### Part 2 — Lane state (daemon, no AI)

A notion of agent liveness richer than Running/Stopped/Exited, sufficient to
distinguish: working (mid-turn), waiting on the human, idle (ready, nothing
queued), and suspected stalled (running but without observable progress beyond
a threshold). This is what "all my agents are hard at work" is measured against,
and it is what tells the orchestrator there is capacity.

### Part 3 — The orchestrator agent

One long-lived agent session, owned by the daemon, not belonging to any
workspace. It has:

- **Standing instructions**, in the user's prose, durable across restarts, which
  they can edit or simply tell it in chat.
- **Its own chat**, top-level, where it reports what it did and where the user
  can direct it ("focus everything on the release this week").
- **An all-scope MCP role**, so it can read and act across every project and
  workspace — the one place the current per-workspace guard must be widened,
  deliberately and narrowly.
- **Digest wake-ups**: the daemon batches and debounces events and wakes it with
  a short summary of what changed, rather than streaming every event at it.

**What it does.** Its job is driving work that already exists to completion, not
sourcing new work. Unasked it may: unstick stalled chats, answer an agent's
prompts and questions on the human's behalf, push finished work through checks,
summary and review, keep summaries honest, and tell the human things. It does
**not** create workspaces or start new work unless the human specifically asks
it to — that is a direct decision from the design conversation, and it is what
keeps this from becoming a backlog engine.

**Answering on the human's behalf is unrestricted.** The human chose this
explicitly: the orchestrator may answer any prompt or question an agent raises,
using its standing instructions, and the human reads what it decided in its
chat afterwards. It is not limited to read-only or obviously-safe approvals.

**Its own outward-facing actions stay gated.** Creating or merging a pull
request, pushing, and archiving a workspace still become an attention item
awaiting the human rather than happening.

**Known tension, left deliberately.** Those two rules overlap: an agent can ask
for permission to push, and under unrestricted answering the orchestrator may
approve it, reaching an outcome its own gated tools would have refused. The
asymmetry is intentional — gating the orchestrator's *initiative* while trusting
its *answers* — and was flagged to the human when it was chosen. A builder
should not silently close the gap in either direction.

### Part 4 — Notifications

Reuse the existing notification path. The orchestrator can raise a notification
deliberately ("I need you"), and the daemon's reflexes continue to raise theirs.
The quality bar: a notification means the human is actually needed, not that
something merely happened.

## Decisions already made

- Shape is approach C: daemon reflexes plus one leashed global orchestrator.
- Global across all projects, above the project level. Not per-project.
- The orchestrator is AI-driven and gets its own chat the human can talk to.
- The attention queue is derived daemon state and works with the AI off.
- Existing `tasks` are an output, not the input.
- Build on `background_tasks.rs` for running work, rather than a second runner.
- Reuse `notifications.rs` and the desktop toast/notification path.
- One orchestrator, not one per project.
- The orchestrator drives existing work to completion; it does not source new
  work, and it creates a workspace only when the human specifically asks.
- The orchestrator may answer any agent prompt or question on the human's
  behalf; the human reviews afterwards in its chat.
- iOS is in scope for real views, not notifications alone: the attention queue
  and the orchestrator chat get iOS surfaces so the human can triage and direct
  from their phone.

## Calls made by the author of this document

Flagged so they can be overridden on reading:

- **The orchestrator never merges, pushes, opens a PR, or archives without
  asking.** Irreversible and outward-facing actions stay gated regardless of
  standing instructions, because trust lost here does not come back.
- **It never invents work.** Idle lanes are filled from what the human queued or
  from explicit standing instructions, not from the orchestrator's own reading
  of what would be good to do.
- **Exactly one orchestrator**, not one per project, because the stated value is
  a single place and a single agent.
- **Off by default**, and switchable off at any time, with the attention queue
  still fully functional.
- **No new concurrency model.** A "lane" is an existing chat thread with an agent
  session in a workspace; there is no slot count and no cap, because nothing in
  the product has one today. "All my agents are hard at work" is measured against
  the chats that exist, not against a capacity denominator.
- **Gating is enforced daemon-side, not by prompt.** (Applies to the
  orchestrator's own tool calls. Answering agents' prompts is ungated by the
  human's decision above.) A gated call from the
  orchestrator does not merely get discouraged in a system prompt: it becomes an
  attention item awaiting the human and returns to the orchestrator as pending,
  rather than blocking its turn.
- **The orchestrator's own activity is excluded from its own senses.** Inputs and
  events gain provenance (who caused this), the orchestrator's thread raises no
  attention items, and its own turns do not wake it. Without this the digest loop
  self-feeds, which is the "expensive to leave running" anti-goal.
- **"Diff ready and unread" ships without read-tracking.** There is no daemon-side
  read state today (`workspace_ui_state` stores only `changes_scope`; the current
  unread notion is client-local in `desktop/src/store/turnSound.ts`). The item is
  derived as "the agent finished and the human has taken no action since", and
  clears on any human action in that workspace. Cross-device read sync is out of
  scope.
- **The queue is daemon-local.** The attention queue is one store in core, read by
  whichever client is pointed at that daemon, and the orchestrator runs on the
  daemon. Merging the attention queues of several hosts is deliberately later.
- **Existing per-turn notifications are left alone.** `event_notification` keeps
  firing as it does today; orchestrator-raised notifications are additive and
  deduped against a reflex notification for the same condition. Changing today's
  notification behaviour is a separate decision, not a side effect of this.
- **CLI parity is a one-shot send plus a transcript tail**, matching how
  `archductor chat` and `archcar send` already work. No interactive REPL.

## Left to the builder

- The concrete storage, RPC, and event shapes for attention items and lane
  state, following existing patterns in `workspace.rs` / `protocol.rs`.
- The stall heuristic and its threshold. Start simple and observable; it is
  tunable, and a wrong guess here is cheap to change.
- Debounce and batch policy for digests, chosen so an orchestrator left running
  all day is affordable.
- How to give one session the `Full` MCP profile when registration is device-wide
  and user-scope today (`crates/core/src/mcp.rs`), keeping the per-workspace guard
  intact for every ordinary session. This interacts with daemon-side gating: the
  orchestrator must reach `Full`'s breadth while its destructive calls stay gated.
- Where a workspace-less chat thread lives, given `chat_threads.workspace_id` is
  `NOT NULL` and every spawn RPC takes a mandatory workspace. Two routes: a
  synthetic hidden workspace (cheap, but must then be suppressed in session lists,
  the dashboard buckets, achievement counts, the sidebar and iOS), or a nullable
  `workspace_id` (invasive: notification joins, provider events/inputs, agent
  status listing, and every client that keys chats by workspace). Also decide the
  orchestrator agent's working directory and what git/repo context it gets.
- How lane state extends `AgentActivity` rather than duplicating it, and which
  notion the surfaces trust.
- Which provider the orchestrator session uses, and how it is configured.
- The ranking function for the attention queue.
- Layout of the top-level surface in the desktop app, the matching CLI commands,
  and the iOS views for the attention queue and the orchestrator chat, including
  where an existing notification tap should land now that both exist
  (`ios/Archductor/RemoteNotificationDelegate.swift` and its tap-router tests).
- How the human "specifically asks" for new work: in the orchestrator's chat in
  prose, or through the existing workspace-creation paths. Prose in its chat is
  the author's expectation.
- Sequencing. The attention queue plus lane state ships and is useful on its
  own; the orchestrator lands on top of it.
