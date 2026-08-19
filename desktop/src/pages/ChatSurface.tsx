import { For, Match, Show, Switch, createEffect, createMemo, createResource, createSignal, on, onCleanup, onMount } from "solid-js";
import {
  chatStore,
  threadsStore,
  nav,
  loadThread,
  interactionsStore,
  actions,
  prefsStore,
  newChatContextStore,
  workspacesStore,
} from "@/store";
import { timelineItemsForSlice } from "@/store/chat";
import { MODELS, EFFORTS } from "@/lib/models";
import { send } from "@/bridge/client";
import type {
  ArchcarChatThread,
  ArchcarChatTranscriptSummary,
  ArchcarContextPlan,
  ArchcarProjectionItem,
  ProviderInteractionRecord,
  ProviderInteractionResolution,
  SessionKind,
} from "@/bridge/protocol";
import { titleCaseWorkspace } from "@/lib/text";
import { isDisplayableTimelineItem } from "@/lib/timeline";
import { DiffView } from "./WorkspaceChanges";
import { registerOpenFile, registerOpenCommit } from "./openFileBridge";
import Diff from "@/components/Diff";
import CompactSelect from "@/components/CompactSelect";
import Icon from "@/components/Icon";
import type { IconName } from "@/components/Icon";
import { renderMarkdown } from "@/lib/markdown";
import { highlightCode, langFromPath } from "@/lib/highlight";
import { applyIndent } from "@/lib/indent";
import { ansiToHtml } from "@/lib/ansi";
import {
  formatReasoningText,
  inlineEventVerbChip,
  isDiffCard,
  isTerminalCard,
  stripArchductorMetadata,
} from "@/lib/chatFormat";
import { composerPrimaryAction } from "@/lib/composerPrimaryAction";
import { parseKeybindingOverrides, resolveShortcut } from "@/lib/shortcuts";
import {
  contextPreamble,
  formatPlan,
  formatTranscript,
  planPickKey,
  transcriptChipDetail,
  transcriptPickKey,
} from "@/lib/newChatContext";
import { isNearScrollBottom, scrollBottomTop } from "@/lib/chatScroll";

// Chat surface — center panel of the command center. Holds chat tabs + open-file
// tabs, a content stack (chat timeline or a file's diff), and the composer.
// Chats are provider sessions (codex/claude) driven by archcar; the projected
// timeline is built in core (get_chat_projection) so this file only maps
// render_class -> component.

let optimisticMessageSeq = 0;

function providerToKind(provider: string): SessionKind {
  if (provider === "codex" || provider === "claude" || provider === "shell") return provider;
  return "codex";
}

function ThreadTab(props: {
  thread: ArchcarChatThread;
  label: string;
  active: boolean;
  queued: number;
  pendingInteraction: boolean;
  onClick: () => void;
  onClose: () => void;
}) {
  const generating = () => props.thread.status === "running" || props.thread.status === "generating";
  const showFinishedDot = () =>
    !props.active &&
    !generating() &&
    !props.pendingInteraction &&
    chatStore.slice(props.thread.id).completedTurnAttention;
  const showAttentionDot = () => !props.active && props.pendingInteraction;
  return (
    <div
      class="ws-chat-tab-shell ws-tab-shell"
      classList={{ "ws-tab-active": props.active }}
      onClick={props.onClick}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          props.onClick();
        }
      }}
      role="button"
      tabIndex={0}
      title={`${props.thread.provider} · ${props.thread.status || "ready"}`}
    >
      <Show when={showFinishedDot() || showAttentionDot()}>
        <span
          class="ws-chat-tab-dot"
          classList={{ "ws-chat-tab-needs-input": showAttentionDot() }}
        />
      </Show>
      <span class="ws-chat-tab-text">
        <span class="ws-tab-label">{props.label}</span>
      </span>
      <Show when={props.queued > 0}>
        <span class="ws-chat-tab-count">{props.queued}</span>
      </Show>
      <button
        class="ws-tab-close-button"
        title="Close chat"
        onClick={(e) => {
          e.stopPropagation();
          props.onClose();
        }}
      >
        <Icon name="x" />
      </button>
    </div>
  );
}

function FileTab(props: { path: string; active: boolean; onClick: () => void; onClose: () => void }) {
  return (
    <div
      class="ws-chat-tab-shell ws-tab-shell ws-file-tab"
      classList={{ "ws-tab-active": props.active }}
      onClick={props.onClick}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          props.onClick();
        }
      }}
      role="button"
      tabIndex={0}
      title={props.path}
    >
      <Icon name="file" class="ws-file-tab-icon" />
      <span class="ws-tab-label">File</span>
      <button
        class="ws-tab-close-button"
        title="Close file"
        onClick={(e) => {
          e.stopPropagation();
          props.onClose();
        }}
      >
        <Icon name="x" />
      </button>
    </div>
  );
}

function UserBubble(props: { body: string }) {
  return (
    <div class="chat-user-row">
      <div
        class="chat-user-bubble markdown-body"
        innerHTML={renderMarkdown(stripArchductorMetadata(props.body))}
      />
    </div>
  );
}

function eventIcon(renderClass: string): IconName {
  if (renderClass === "command_card" || renderClass === "process_card" || renderClass === "background_card")
    return "terminal";
  if (renderClass === "file_card") return "file-text";
  if (renderClass === "diff_card") return "git-compare";
  if (renderClass === "reasoning_card") return "brain";
  if (renderClass === "skill_card" || renderClass === "tool_card" || renderClass === "plugin_card") return "wrench";
  if (renderClass === "subagent_card" || renderClass === "nested_transcript_card") return "bolt";
  return "wrench";
}

// Inline "chip-card" event — GTK's inline_event_widget: a flat row of expander +
// verb (action label) + a small monospace content chip (the command/filename),
// with the body revealed only on expand. No category badge; the row carries no
// card chrome of its own. Bodies stay collapsed until the user asks for them.
function InlineCard(props: { item: ArchcarProjectionItem; agentIdle?: boolean }) {
  const [open, setOpen] = createSignal(false);
  const parsed = () => inlineEventVerbChip(props.item.render_class, props.item.title);
  const verb = () => parsed().verb;
  const chip = () => parsed().chip;
  const hasBody = () => props.item.body.trim().length > 0;
  return (
    <div
      class="chat-inline-event"
      classList={{
        "chat-inline-event-failed": props.item.status === "failed",
        "chat-inline-event-loading": props.item.status === "running" && !props.agentIdle,
      }}
    >
      <div class="chat-inline-event-header">
        <button
          class="chat-inline-event-expander"
          title={hasBody() ? "Show details" : undefined}
          disabled={!hasBody()}
          onClick={() => setOpen((o) => !o)}
        >
          <Show when={hasBody()} fallback={<span class="chat-inline-event-dot" />}>
            <span class="chat-inline-event-expander-glyph">{open() ? "−" : "+"}</span>
          </Show>
        </button>
        <Icon name={eventIcon(props.item.render_class)} class="chat-inline-event-icon" />
        <span class="chat-inline-event-action">{verb()}</span>
        <Show when={chip()}>
          <span class="chat-inline-event-chip">
            <span class="chat-inline-event-chip-label">{chip()}</span>
          </span>
        </Show>
      </div>
      <Show when={open() && hasBody()}>
        <Switch fallback={<div class="chat-inline-event-body">{props.item.body}</div>}>
          <Match when={isDiffCard(props.item)}>
            <Diff text={props.item.body} />
          </Match>
          <Match when={isTerminalCard(props.item)}>
            <pre class="chat-inline-event-terminal" innerHTML={ansiToHtml(props.item.body)} />
          </Match>
        </Switch>
      </Show>
    </div>
  );
}

function ReasoningBlock(props: { item: ArchcarProjectionItem }) {
  const body = () => formatReasoningText(props.item.body);
  return (
    <section
      class="chat-reasoning-block"
      classList={{ "chat-reasoning-block-streaming": props.item.stream_state === "streaming" }}
      aria-label="Agent reasoning"
    >
      <div class="chat-reasoning-text">{body()}</div>
    </section>
  );
}

// Agent asked for something mid-turn (permission / question / plan approval).
// Rendered above the composer with actionable buttons; resolving it unblocks the
// turn (else tools that require approval silently stall).
function InteractionBanner(props: { rec: ProviderInteractionRecord }) {
  const resolve = (resolution: ProviderInteractionResolution) =>
    void actions.resolveInteraction(props.rec.id, resolution).catch(() => {});
  const [other, setOther] = createSignal<Record<string, string>>({});
  const questions = () => props.rec.questions ?? [];
  const isQuestion = () => props.rec.kind === "user_question" && questions().length > 0;

  const answer = (questionId: string, value: string) => {
    if (!value.trim()) return;
    resolve({ type: "answer", answers: [{ question_id: questionId, values: [value] }] });
  };

  return (
    <div class="chat-interaction">
      <div class="chat-interaction-head">
        <span class="chat-interaction-kind">{props.rec.kind.replace(/_/g, " ")}</span>
        <span class="chat-interaction-title">{props.rec.title}</span>
      </div>
      <Show when={isQuestion()} fallback={<PermissionActions rec={props.rec} resolve={resolve} />}>
        <For each={questions()}>
          {(question) => (
            <div class="chat-interaction-question">
              <div class="chat-interaction-detail">{question.question}</div>
              <div class="chat-interaction-actions">
                <For each={question.options}>
                  {(option) => (
                    <button
                      class="ui-button-sm"
                      title={option.description}
                      onClick={() => answer(question.id, option.label)}
                    >
                      {option.label}
                    </button>
                  )}
                </For>
              </div>
              {/* Providers mark a question as accepting free text; without it,
                  answering means picking one of the offered labels. */}
              <Show when={question.allow_other}>
                <div class="chat-interaction-other">
                  <input
                    class="chat-interaction-other-input"
                    placeholder="Answer in your own words…"
                    value={other()[question.id] ?? ""}
                    onInput={(e) =>
                      setOther((prev) => ({ ...prev, [question.id]: e.currentTarget.value }))
                    }
                    onKeyDown={(e) => {
                      if (e.key !== "Enter") return;
                      e.preventDefault();
                      answer(question.id, other()[question.id] ?? "");
                    }}
                  />
                  <button
                    class="ui-button-sm"
                    onClick={() => answer(question.id, other()[question.id] ?? "")}
                  >
                    Send
                  </button>
                </div>
              </Show>
            </div>
          )}
        </For>
      </Show>
    </div>
  );
}

function PermissionActions(props: {
  rec: ProviderInteractionRecord;
  resolve: (resolution: ProviderInteractionResolution) => void;
}) {
  return (
    <>
      <Show when={props.rec.detail.trim()}>
        <div class="chat-interaction-detail">{props.rec.detail}</div>
      </Show>
      <div class="chat-interaction-actions">
        <button class="ui-button-primary" onClick={() => props.resolve({ type: "approve" })}>
          Allow
        </button>
        <button
          class="ui-button-sm"
          title="Allow this and anything like it for the rest of the session"
          onClick={() => props.resolve({ type: "approve_for_session" })}
        >
          Allow for session
        </button>
        <button class="ui-button-destructive" onClick={() => props.resolve({ type: "deny" })}>
          Deny
        </button>
      </div>
    </>
  );
}

// The plan the agent proposed, shown as its own block with the file it was
// written to. Approving it is what ends planning and starts the build, so the
// buttons live in the composer where the next action is.
function PlanCard(props: { rec: ProviderInteractionRecord }) {
  return (
    <div class="chat-plan-card">
      <div class="chat-plan-card-head">
        <Icon name="file-text" class="chat-plan-card-icon" />
        <span class="chat-plan-card-title">Proposed plan</span>
        <Show when={props.rec.plan_path}>
          {(path) => <span class="chat-plan-card-path">{path()}</span>}
        </Show>
      </div>
      <div
        class="chat-plan-card-body markdown-body"
        innerHTML={renderMarkdown(props.rec.detail)}
      />
    </div>
  );
}

function TimelineItem(props: { item: ArchcarProjectionItem; agentIdle: boolean }) {
  const cls = () => props.item.render_class;
  return (
    <Switch fallback={<InlineCard item={props.item} agentIdle={props.agentIdle} />}>
      <Match when={cls() === "user_chat"}>
        <UserBubble body={props.item.body} />
      </Match>
      <Match when={cls() === "assistant_chat"}>
        <div
          class="chat-agent-text markdown-body"
          innerHTML={renderMarkdown(stripArchductorMetadata(props.item.body))}
        />
      </Match>
      <Match when={cls() === "reasoning_card"}>
        <ReasoningBlock item={props.item} />
      </Match>
    </Switch>
  );
}

// Empty-chat screen: name the branch this chat runs on, then offer the context
// a fresh chat usually needs — recent chat transcripts (conversation only, no
// tool calls) and plan markdown from `.context/plans/`. Picked chips ride along
// with the first message the composer sends.
function NewChatIntro(props: { workspace: string; threadId: number }) {
  const branch = () => workspacesStore.row(props.workspace)?.branch ?? props.workspace;

  const [transcripts] = createResource(
    () => props.workspace,
    async (workspace) => {
      try {
        const res = await send({ type: "list_chat_transcripts", workspace });
        return res.type === "chat_transcripts" ? res.transcripts : [];
      } catch {
        return [];
      }
    },
  );
  const [plans] = createResource(
    () => props.workspace,
    async (workspace) => {
      try {
        const res = await send({ type: "list_context_plans", workspace });
        return res.type === "context_plans" ? res.plans : [];
      } catch {
        return [];
      }
    },
  );

  // This chat has no messages yet, so it never lists itself.
  const pastChats = createMemo(() =>
    (transcripts() ?? []).filter((t) => t.thread_id !== props.threadId),
  );
  const selected = (key: string) => newChatContextStore.selected(props.threadId, key);

  async function toggleTranscript(summary: ArchcarChatTranscriptSummary) {
    const key = transcriptPickKey(summary.thread_id);
    if (selected(key)) {
      newChatContextStore.remove(props.threadId, key);
      return;
    }
    try {
      const res = await send({ type: "get_chat_transcript", thread_id: summary.thread_id });
      if (res.type !== "chat_transcript") return;
      newChatContextStore.toggle(props.threadId, {
        key,
        kind: "transcript",
        label: res.title || summary.title,
        body: formatTranscript(res.title || summary.title, res.messages),
      });
    } catch {
      // non-fatal: leave the chip unselected
    }
  }

  async function togglePlan(plan: ArchcarContextPlan) {
    const key = planPickKey(plan.path);
    if (selected(key)) {
      newChatContextStore.remove(props.threadId, key);
      return;
    }
    try {
      const res = await send({
        type: "read_workspace_file",
        workspace: props.workspace,
        path: plan.path,
      });
      if (res.type !== "workspace_file_content") return;
      newChatContextStore.toggle(props.threadId, {
        key,
        kind: "plan",
        label: plan.title,
        body: formatPlan(plan.title, plan.path, res.content),
      });
    } catch {
      // non-fatal: leave the chip unselected
    }
  }

  return (
    <div class="new-chat-intro">
      <div class="new-chat-title">
        New chat in <span class="new-chat-branch">{branch()}</span>
      </div>

      <div class="new-chat-section">
        <div class="new-chat-section-label">Add chat transcripts</div>
        <Show
          when={pastChats().length > 0}
          fallback={
            <div class="new-chat-hint">
              {transcripts.loading ? "Loading…" : "No past chats in this workspace yet."}
            </div>
          }
        >
          <div class="new-chat-chips">
            <For each={pastChats()}>
              {(summary) => (
                <button
                  class="new-chat-chip"
                  classList={{ "new-chat-chip-on": selected(transcriptPickKey(summary.thread_id)) }}
                  title={`${summary.provider} · ${summary.updated_at}`}
                  onClick={() => void toggleTranscript(summary)}
                >
                  <Icon
                    name={selected(transcriptPickKey(summary.thread_id)) ? "circle-check" : "history"}
                  />
                  <span class="new-chat-chip-label">{summary.title}</span>
                  <span class="new-chat-chip-detail">
                    {transcriptChipDetail(summary.message_count)}
                  </span>
                </button>
              )}
            </For>
          </div>
        </Show>
      </div>

      <div class="new-chat-section">
        <div class="new-chat-section-label">Add plans</div>
        <Show
          when={(plans() ?? []).length > 0}
          fallback={
            <div class="new-chat-hint">
              {plans.loading ? "Loading…" : "No plans saved in .context/plans/ yet."}
            </div>
          }
        >
          <div class="new-chat-chips">
            <For each={plans() ?? []}>
              {(plan) => (
                <button
                  class="new-chat-chip"
                  classList={{ "new-chat-chip-on": selected(planPickKey(plan.path)) }}
                  title={plan.path}
                  onClick={() => void togglePlan(plan)}
                >
                  <Icon name={selected(planPickKey(plan.path)) ? "circle-check" : "file-text"} />
                  <span class="new-chat-chip-label">{plan.title}</span>
                </button>
              )}
            </For>
          </div>
        </Show>
      </div>
    </div>
  );
}

function Timeline(props: { threadId: number; workspace: string }) {
  let scrollRef: HTMLDivElement | undefined;
  let followBottom = true;
  const slice = () => chatStore.slice(props.threadId);
  const items = createMemo<ArchcarProjectionItem[]>(() =>
    timelineItemsForSlice(slice()).filter(isDisplayableTimelineItem),
  );
  const scrollSignal = createMemo(() =>
    items()
      .map((item) => `${item.id}:${item.status}:${item.stream_state}:${item.body.length}`)
      .join("|"),
  );
  // An interrupted (or crashed) turn leaves its command/tool cards marked
  // "running". Once the agent is idle nothing is running, so those must stop
  // spinning — a permanent spinner reads as a hung app.
  const agentIdle = () => {
    const session = slice().session;
    return session == null || session.ready === true;
  };

  function updateFollowBottom() {
    const el = scrollRef;
    if (!el) return;
    followBottom = isNearScrollBottom(el);
  }

  function scrollToBottom(behavior: ScrollBehavior) {
    const el = scrollRef;
    if (!el) return;
    el.scrollTo({ top: scrollBottomTop(el), behavior });
  }

  onMount(() => {
    requestAnimationFrame(() => scrollToBottom("auto"));
  });

  createEffect(
    on(scrollSignal, () => {
      if (!followBottom) return;
      requestAnimationFrame(() => scrollToBottom("smooth"));
    }),
  );

  return (
    <div class="chat-timeline-scroll" ref={scrollRef} onScroll={updateFollowBottom}>
      <div class="chat-messages">
        <Show
          when={items().length > 0}
          fallback={<NewChatIntro workspace={props.workspace} threadId={props.threadId} />}
        >
          <For each={items()}>{(item) => <TimelineItem item={item} agentIdle={agentIdle()} />}</For>
        </Show>
      </div>
    </div>
  );
}

/** Message for a failed send/start, kept short enough for the banner line. */
function sendErrorText(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  const text = raw.trim();
  return text.length > 0 ? text : "The agent could not be reached.";
}

function Composer(props: {
  threadId: number;
  workspace: string;
  provider: string;
  onChangeProvider: (provider: string) => void;
  // Model to apply to this chat's session once it first becomes ready. Set only
  // for freshly created chats so existing chats keep their own model choice.
  seedModel?: string;
  onSeeded?: () => void;
}) {
  const [text, setText] = createSignal("");
  // Pasted blobs saved to the workspace as files; sent as path references so the
  // agent reads them instead of us inlining a huge string.
  const [attachments, setAttachments] = createSignal<{ path: string; label: string }[]>([]);
  const slice = () => chatStore.slice(props.threadId);
  const sessionKind = () => providerToKind(props.provider);
  const busy = () => slice().session?.ready === false && slice().session != null;
  // Between "message queued" and the daemon's first session event there is no
  // session to read state from, so the phase carries the starting signal.
  const starting = () => slice().phase.kind === "starting" && slice().session == null;
  const running = () => slice().session?.runtime_state === "running";
  const sessionId = () => slice().session?.session_id ?? null;
  const models = () => MODELS[props.provider] ?? [];

  // Readiness watchdog: a session that never reports ready (e.g. the agent CLI
  // hangs on a first-run prompt) shouldn't read as an infinite "starting…" dead
  // end. After a grace period we say so plainly — sending still works, since a
  // message typed while starting is queued and delivered once the turn goes idle.
  const [slowStart, setSlowStart] = createSignal(false);
  createEffect(() => {
    if (!busy() && !starting()) {
      setSlowStart(false);
      return;
    }
    const timer = setTimeout(() => setSlowStart(true), 15000);
    onCleanup(() => clearTimeout(timer));
  });

  const [model, setModel] = createSignal(props.seedModel ?? "");
  const [effort, setEffort] = createSignal("high");

  // Seed a new chat's model: once its session is live, push the default model so
  // the chat has something to go off of. Runs once, then hands back to the user.
  let seeded = false;
  createEffect(() => {
    const sid = sessionId();
    if (seeded || !props.seedModel || sid == null) return;
    seeded = true;
    setModel(props.seedModel);
    void send({ type: "set_session_model", session_id: sid, model: props.seedModel }).catch(() => {});
    props.onSeeded?.();
  });

  const contextPercent = createMemo(() => {
    const msgs = slice().messages;
    for (let i = msgs.length - 1; i >= 0; i--) {
      const pct = msgs[i].context_usage?.percent;
      if (pct != null) return Math.round(pct);
    }
    return null;
  });

  function addOptimisticMessage(body: string): number {
    const id = -(Date.now() * 1000 + optimisticMessageSeq++);
    chatStore.optimisticAppend(props.threadId, {
      id,
      role: "user",
      content: body,
      source: "desktop_optimistic",
    });
    return id;
  }

  function changeModel(next: string) {
    setModel(next);
    const sid = sessionId();
    if (sid != null) void send({ type: "set_session_model", session_id: sid, model: next }).catch(() => {});
  }
  function changeEffort(next: string) {
    setEffort(next);
    const sid = sessionId();
    if (sid != null) void send({ type: "set_session_effort", session_id: sid, effort: next }).catch(() => {});
  }

  const PASTE_TO_FILE_CHARS = 2000;

  // Combine the typed text with any pasted-file references and context picked
  // on the empty-chat screen. `input` (to the agent) carries the transcript /
  // plan text and the file paths; `visible` (shown in the UI) gets compact 📎
  // markers so the timeline isn't cluttered with paths or pasted transcripts.
  function buildPayload(): { input: string; visible: string } | null {
    const value = text().trim();
    const atts = attachments();
    if (!value && atts.length === 0) return null;
    const picks = newChatContextStore.picks(props.threadId);
    const refs = atts.map((a) => `Attached file (${a.label}): ${a.path}`);
    const input = [contextPreamble(picks), value, ...refs].filter(Boolean).join("\n\n");
    const visible = [
      value,
      ...picks.map((pick) => `📎 ${pick.label}`),
      ...atts.map((a) => `📎 ${a.label}`),
    ]
      .filter(Boolean)
      .join("  ");
    return { input, visible };
  }

  function clearComposer() {
    setText("");
    setAttachments([]);
    // Picked context rides on one message only; a follow-up shouldn't resend it.
    newChatContextStore.clear(props.threadId);
  }

  // Large paste → save to a workspace file and attach it as a chip instead of
  // dumping thousands of characters into the textarea.
  async function onPaste(e: ClipboardEvent) {
    const pasted = e.clipboardData?.getData("text") ?? "";
    if (pasted.length <= PASTE_TO_FILE_CHARS) return; // small paste: default behaviour
    e.preventDefault();
    try {
      const res = await send({ type: "save_chat_paste", thread_id: props.threadId, text: pasted });
      if (res.type === "chat_paste_saved") {
        setAttachments((a) => [...a, { path: res.relative_path, label: res.label }]);
      } else {
        setText((t) => t + pasted);
      }
    } catch {
      setText((t) => t + pasted);
    }
  }

  // Normal send → queue. Core delivers it when the turn goes idle (and rejects
  // auto-delivery mid-turn), so queuing is always safe regardless of state.
  // Core also starts the chat's agent session when the queue has nothing to
  // deliver into, so the first message of a brand-new chat sends itself.
  async function queueSend() {
    const payload = buildPayload();
    if (!payload) return;
    // Snapshot composer state so a send failure restores the chips too, not just
    // the raw text (payload.input inlines file-reference paths).
    const prevText = text();
    const prevAtts = attachments();
    const prevPicks = newChatContextStore.picks(props.threadId);
    const pendingId = addOptimisticMessage(payload.visible);
    clearComposer();
    // Say "starting" before the daemon's first event arrives: spawning the
    // agent takes seconds, and silence there reads as a dropped message.
    if (sessionId() == null) {
      chatStore.setPhase(props.threadId, { kind: "starting", provider: sessionKind() });
    }
    try {
      const res = await send({
        type: "queue_chat_input",
        thread_id: props.threadId,
        input: payload.input,
        visible_input: payload.visible,
        kind: "user",
        session_kind: sessionKind(),
      });
      if (res.type === "error") throw new Error(res.message);
    } catch (err) {
      chatStore.removeOptimistic(props.threadId, pendingId);
      chatStore.setPhase(props.threadId, { kind: "failed", message: sendErrorText(err) });
      setText(prevText);
      setAttachments(prevAtts);
      newChatContextStore.set(props.threadId, prevPicks);
    }
  }

  // Steer → deliver immediately, injecting into the running turn (or starting a
  // new one) and skipping the queue. Needs a live session; falls back to queue.
  async function steerSend() {
    const sid = sessionId();
    if (sid == null) {
      await queueSend();
      return;
    }
    const payload = buildPayload();
    if (!payload) return;
    const prevText = text();
    const prevAtts = attachments();
    const prevPicks = newChatContextStore.picks(props.threadId);
    const pendingId = addOptimisticMessage(payload.visible);
    clearComposer();
    try {
      const res = await send({
        type: "send_input",
        session_id: sid,
        input: payload.input,
        visible_input: payload.visible,
        kind: "user",
        delivery: "immediate",
      });
      if (res.type === "error") throw new Error(res.message);
    } catch (err) {
      chatStore.removeOptimistic(props.threadId, pendingId);
      chatStore.setPhase(props.threadId, { kind: "failed", message: sendErrorText(err) });
      setText(prevText);
      setAttachments(prevAtts);
      newChatContextStore.set(props.threadId, prevPicks);
    }
  }

  // Recovery: restart this chat's agent session. Queued messages stay queued and
  // drain as soon as the new session reports ready.
  async function retrySession() {
    chatStore.setPhase(props.threadId, { kind: "starting", provider: sessionKind() });
    try {
      const res = await send({
        type: "ensure_chat_thread_session",
        workspace: props.workspace,
        thread_id: props.threadId,
        kind: sessionKind(),
      });
      if (res.type === "error") throw new Error(res.message);
    } catch (err) {
      chatStore.setPhase(props.threadId, { kind: "failed", message: sendErrorText(err) });
    }
  }

  // Stop the active turn.
  async function interrupt() {
    const sid = sessionId();
    if (sid != null) await send({ type: "interrupt_turn", session_id: sid }).catch(() => {});
  }

  function defaultEnterSend() {
    void queueSend();
  }

  function primaryAction() {
    if (composerPrimaryAction(running()) === "interrupt") {
      void interrupt();
      return;
    }
    defaultEnterSend();
  }

  async function removeQueued(queueId: number) {
    await send({ type: "remove_queued_chat_input", queue_id: queueId }).catch(() => {});
  }
  async function moveQueued(queueId: number, up: boolean) {
    await send({ type: "move_queued_chat_input", queue_id: queueId, up }).catch(() => {});
  }
  // Send a queued item now as a steer, then drop it from the queue.
  async function steerQueued(q: { id: number; input: string; visible_input?: string }) {
    const sid = sessionId();
    if (sid == null) return;
    const pendingId = addOptimisticMessage(q.visible_input ?? q.input);
    try {
      await send({
        type: "send_input",
        session_id: sid,
        input: q.input,
        visible_input: q.visible_input,
        kind: "user",
        delivery: "immediate",
      });
      // Only drop from the queue once delivery succeeded — otherwise a failed
      // send would silently discard the user's message.
      await removeQueued(q.id);
    } catch {
      chatStore.removeOptimistic(props.threadId, pendingId);
      // keep the item queued so the user can retry
    }
  }

  function onKeyDown(e: KeyboardEvent) {
    const shortcut = resolveShortcut(e, parseKeybindingOverrides(prefsStore.state.keybindings));
    if (shortcut === "toggle-plan-mode") {
      e.preventDefault();
      void togglePlanMode();
      return;
    }
    if (shortcut === "approve-plan") {
      e.preventDefault();
      void approvePlan();
      return;
    }
    if (e.key !== "Enter" || e.shiftKey) return; // Shift+Enter → newline
    e.preventDefault();
    // While a plan is under review, Enter sends revision notes back to the
    // agent instead of starting an unrelated turn.
    if (pendingPlan()) {
      void sendPlanRevision();
      return;
    }
    // The immediate-send chord is customizable; plain Enter keeps the queue-first composer behavior.
    if (shortcut === "send-immediate") {
      void steerSend();
    } else defaultEnterSend();
  }

  const failure = () => {
    const phase = slice().phase;
    return phase.kind === "failed" ? phase.message : null;
  };

  // A plan waiting on review changes what the composer is for: the next thing
  // you do is approve it or say what to change, not start a new turn.
  const pendingPlan = () => {
    const pending = interactionsStore.pending(props.threadId);
    return pending?.kind === "plan_approval" ? pending : null;
  };
  const planMode = () => chatStore.slice(props.threadId).planMode;
  // The session reads as "not ready" while an ask is outstanding, but it is not
  // starting up — it is blocked on the human.
  const awaitingUser = () => interactionsStore.pending(props.threadId) != null;

  async function togglePlanMode() {
    const next = !planMode();
    chatStore.setPlanMode(props.threadId, next);
    try {
      const res = await send({ type: "set_chat_plan_mode", thread_id: props.threadId, plan_mode: next });
      if (res.type === "error") throw new Error(res.message);
    } catch (err) {
      chatStore.setPlanMode(props.threadId, !next);
      chatStore.setPhase(props.threadId, { kind: "failed", message: sendErrorText(err) });
    }
  }

  async function approvePlan() {
    const plan = pendingPlan();
    if (!plan) return;
    await actions.resolveInteraction(plan.id, { type: "approve" }).catch((err) => {
      chatStore.setPhase(props.threadId, { kind: "failed", message: sendErrorText(err) });
    });
  }

  /** Typing while a plan is up means "revise it", which is a denial with notes. */
  async function sendPlanRevision() {
    const plan = pendingPlan();
    const feedback = text().trim();
    if (!plan || !feedback) return;
    const prevText = text();
    clearComposer();
    await actions
      .resolveInteraction(plan.id, { type: "deny", reason: feedback })
      .catch((err) => {
        setText(prevText);
        chatStore.setPhase(props.threadId, { kind: "failed", message: sendErrorText(err) });
      });
  }

  return (
    <div class="chat-composer">
      <Show when={failure()}>
        {(message) => (
          <div class="chat-error-banner" role="alert">
            <Icon name="alert" class="chat-error-banner-icon" />
            <span class="chat-error-banner-text">{message()}</span>
            <button class="chat-error-banner-btn" onClick={() => void retrySession()}>
              Restart agent
            </button>
            <button
              class="chat-error-banner-btn chat-error-banner-dismiss"
              title="Dismiss"
              onClick={() => chatStore.setPhase(props.threadId, { kind: "ready" })}
            >
              <Icon name="x" />
            </button>
          </div>
        )}
      </Show>
      <Show when={pendingPlan()}>
        <div class="chat-plan-review">
          <span class="chat-plan-review-label">Plan ready — approve it, or say what to change.</span>
          <button class="ui-button-primary chat-plan-approve" onClick={() => void approvePlan()}>
            Approve &amp; build
          </button>
        </div>
      </Show>
      <Show when={slice().queue.length > 0}>
        <div class="chat-queue-overlay">
          <div class="chat-queue-heading">Queued</div>
          <For each={slice().queue}>
            {(q) => (
              <div class="chat-queued-composer-row">
                <span class="chat-queued-composer-body">{q.visible_input ?? q.input}</span>
                <div class="chat-queued-actions">
                  <button class="chat-queued-action-btn" title="Move up" onClick={() => void moveQueued(q.id, true)}>
                    <Icon name="arrow-up" />
                  </button>
                  <button class="chat-queued-action-btn" title="Move down" onClick={() => void moveQueued(q.id, false)}>
                    <Icon name="arrow-down" />
                  </button>
                  <button
                    class="chat-queued-action-btn"
                    title="Send now (steer)"
                    disabled={sessionId() == null}
                    onClick={() => void steerQueued(q)}
                  >
                    <Icon name="bolt" />
                  </button>
                  <button
                    class="chat-queued-action-btn"
                    title="Remove queued message"
                    onClick={() => void removeQueued(q.id)}
                  >
                    <Icon name="x" />
                  </button>
                </div>
              </div>
            )}
          </For>
        </div>
      </Show>
      <div class="chat-composer-box">
        <Show when={attachments().length > 0}>
          <div class="chat-attachment-chips">
            <For each={attachments()}>
              {(a, i) => (
                <span class="chat-attachment-chip" title={a.path}>
                  <Icon name="paperclip" class="chat-attachment-chip-icon" />
                  <span class="chat-attachment-chip-label">{a.label}</span>
                  <button
                    class="chat-attachment-chip-remove"
                    title="Remove attachment"
                    onClick={() => setAttachments((list) => list.filter((_, j) => j !== i()))}
                  >
                    <Icon name="x" />
                  </button>
                </span>
              )}
            </For>
          </div>
        </Show>
        <div class="chat-input-shell">
          <textarea
            class="chat-input-view"
            data-focus-target="chat-composer"
            placeholder={
              pendingPlan()
                ? "What should change in the plan?"
                : planMode()
                  ? "Describe what to plan — the agent researches, then proposes"
                  : "Ask to make changes, @mention files, run /commands"
            }
            value={text()}
            onInput={(e) => setText(e.currentTarget.value)}
            onKeyDown={onKeyDown}
            onPaste={(e) => void onPaste(e)}
            rows={1}
          />
        </div>
        <div class="chat-toolbar">
          <div class="chat-toolbar-left">
            {/* Provider lives in the composer (like the old GTK bar). Changing it
                opens a NEW chat with that agent; the current chat keeps its own
                model/session untouched. */}
            <CompactSelect
              title="Agent"
              value={props.provider}
              options={[
                { value: "codex", label: "Codex" },
                { value: "claude", label: "Claude" },
              ]}
              onChange={props.onChangeProvider}
              icon="terminal"
              class="chat-agent-select"
            />
            {/* Model + effort are always shown (even when the provider exposes no
                switchable models yet) so the composer controls stay consistent. */}
            <CompactSelect
              title="Model"
              value={model()}
              options={[{ value: "", label: "Model" }, ...models().map((m) => ({ value: m, label: m }))]}
              onChange={changeModel}
              icon="settings"
              class="compact-select-model"
            />
            <CompactSelect
              title="Reasoning effort"
              value={effort()}
              options={EFFORTS.map((x) => ({ value: x, label: titleCaseWorkspace(x) }))}
              onChange={changeEffort}
              icon="brain"
              class="chat-effort-select"
            />
            {/* Plan mode is provider-native: claude runs in its plan permission
                mode, codex plans inside a read-only sandbox. */}
            <button
              class="chat-plan-toggle"
              classList={{ "chat-plan-toggle-on": planMode() }}
              title={
                planMode()
                  ? "Planning — approve a plan to start building"
                  : "Plan before building"
              }
              onClick={() => void togglePlanMode()}
            >
              <Icon name="file-text" />
              <span>Plan</span>
            </button>
          </div>
          <div class="chat-toolbar-right">
            <Show when={contextPercent() != null}>
              <span class="chat-context-usage" title="Context window used">
                <Icon name="panel-right" class="chat-context-usage-icon" />
                <span>{contextPercent()}%</span>
              </span>
            </Show>
            <Show when={awaitingUser()}>
              <span class="chat-context-usage" title="The agent is waiting on your answer">
                <Icon name="alert" class="chat-context-usage-icon" />
                <span>Waiting for you</span>
              </span>
            </Show>
            <Show when={!awaitingUser() && (busy() || starting())}>
              <span class="chat-context-usage" title={slowStart() ? "Agent is still starting" : "Agent starting"}>
                <Icon name="bolt" class="chat-context-usage-icon" />
                <span>{slowStart() ? "Still starting" : "Starting"}</span>
              </span>
            </Show>
            <Show
              when={composerPrimaryAction(running()) === "interrupt"}
              fallback={
                <button
                  class="chat-send-btn"
                  classList={{ "chat-send-btn-active": text().trim().length > 0 || attachments().length > 0 }}
                  onClick={primaryAction}
                  title="Send"
                  disabled={text().trim().length === 0 && attachments().length === 0}
                >
                  <Icon name="arrow-up" />
                </button>
              }
            >
              <button
                class="chat-send-btn chat-stop-btn"
                onClick={primaryAction}
                title="Interrupt"
              >
                <Icon name="square" />
              </button>
            </Show>
          </div>
        </div>
      </div>
    </div>
  );
}

// File view — two modes backed by real RPCs:
//   diff : the three-section unified diff (get_workspace_diff)
//   edit : the file's UTF-8 text (read_workspace_file), editable + savable
//          (write_workspace_file). Binary/oversize files surface the backend
//          error instead of an editor.
function FileEditor(props: { workspace: string; path: string }) {
  const [loaded] = createResource(
    () => [props.workspace, props.path] as const,
    async ([ws, path]) => {
      try {
        const res = await send({ type: "read_workspace_file", workspace: ws, path });
        if (res.type === "workspace_file_content") return { content: res.content, error: null };
        if (res.type === "error") return { content: "", error: res.message };
        return { content: "", error: "Unexpected response" };
      } catch (err) {
        return { content: "", error: (err as Error).message };
      }
    },
  );
  const [draft, setDraft] = createSignal<string | null>(null);
  const [status, setStatus] = createSignal("");
  // Reset the local draft whenever a fresh file load arrives.
  createEffect(() => {
    const l = loaded();
    if (l && !l.error) setDraft(l.content);
  });
  const dirty = () => {
    const l = loaded();
    return l != null && draft() != null && draft() !== l.content;
  };

  async function save() {
    const text = draft();
    if (text == null) return;
    setStatus("Saving…");
    try {
      const res = await send({
        type: "write_workspace_file",
        workspace: props.workspace,
        path: props.path,
        content: text,
      });
      setStatus(res.type === "workspace_file_written" ? "Saved" : "Save failed");
    } catch (err) {
      setStatus(`Save failed: ${(err as Error).message}`);
    }
  }

  // Syntax highlighting overlay: a transparent textarea sits over a highlighted
  // <pre>. Both share identical font metrics + padding so the caret lines up;
  // the textarea drives the scroll and mirrors it onto the highlight layer. A
  // trailing newline keeps the last visual line height correct.
  const lang = createMemo(() => langFromPath(props.path));
  const highlighted = createMemo(() => {
    const text = draft() ?? "";
    return highlightCode(text.endsWith("\n") ? text : text + "\n", lang());
  });
  let highlightRef: HTMLPreElement | undefined;

  function indentSelection(el: HTMLTextAreaElement, dedent: boolean) {
    const res = applyIndent(el.value, el.selectionStart, el.selectionEnd, dedent);
    if (res.text === el.value) return;
    setDraft(res.text);
    // draft() now equals res.text, so the controlled value stays; restore the
    // selection on the next microtask once the DOM has settled.
    queueMicrotask(() => {
      el.selectionStart = res.selStart;
      el.selectionEnd = res.selEnd;
    });
  }

  return (
    <Show
      when={!loaded()?.error}
      fallback={<div class="empty-state">{loaded()?.error}</div>}
    >
      <div class="ws-file-editor">
        <div class="ws-file-editor-scroll">
          <pre class="ws-file-editor-highlight hljs" aria-hidden="true" ref={highlightRef}>
            <code innerHTML={highlighted()} />
          </pre>
          <textarea
            class="ws-file-editor-area"
            spellcheck={false}
            value={draft() ?? ""}
            onInput={(e) => {
              setDraft(e.currentTarget.value);
              setStatus("");
            }}
            onScroll={(e) => {
              if (highlightRef) {
                highlightRef.scrollTop = e.currentTarget.scrollTop;
                highlightRef.scrollLeft = e.currentTarget.scrollLeft;
              }
            }}
            onKeyDown={(e) => {
              if (resolveShortcut(e, parseKeybindingOverrides(prefsStore.state.keybindings)) === "save") {
                e.preventDefault();
                void save();
                return;
              }
              if (e.key === "Tab") {
                e.preventDefault();
                indentSelection(e.currentTarget, e.shiftKey);
                setStatus("");
              }
            }}
          />
        </div>
        <div class="ws-file-editor-footer">
          <span class="card-meta">
            {status() || (dirty() ? "Unsaved changes" : lang() ?? "plain text")}
          </span>
          <button class="suggested-action" disabled={!dirty()} onClick={() => void save()}>
            Save
          </button>
        </div>
      </div>
    </Show>
  );
}

// File-scoped review comments shown beneath the diff — conductor's "comments
// point at changed lines" model. Lists this file's local review comments (by
// line) and lets you add one (line optional) via add_review_comment.
function FileComments(props: { workspace: string; path: string }) {
  const [comments, { refetch }] = createResource(
    () => [props.workspace, props.path] as const,
    async ([ws, path]) => {
      try {
        const res = await send({ type: "list_review_comments", workspace: ws });
        return res.type === "review_comments"
          ? res.comments.filter((c) => c.file_path === path)
          : [];
      } catch {
        return [];
      }
    },
  );
  const [line, setLine] = createSignal("");
  const [body, setBody] = createSignal("");
  async function add() {
    if (!body().trim()) return;
    const lineNum = line().trim() ? Number(line().trim()) : undefined;
    try {
      await actions.addReviewComment({
        workspace: props.workspace,
        filePath: props.path,
        lineNumber: Number.isInteger(lineNum) ? lineNum : undefined,
        body: body().trim(),
      });
      setLine("");
      setBody("");
      await refetch();
    } catch {
      // non-fatal
    }
  }
  return (
    <div class="ws-file-comments">
      <div class="detail-label">Review comments</div>
      <For each={comments() ?? []}>
        {(c) => (
          <div class="ws-file-comment-row">
            <span class="ws-file-comment-loc">{c.line_number != null ? `L${c.line_number}` : "file"}</span>
            <span class="ws-file-comment-body">{c.body}</span>
            <span class="ws-file-comment-status">[{c.status}]</span>
          </div>
        )}
      </For>
      <div class="action-row">
        <input
          class="ws-text-input"
          style={{ "max-width": "70px" }}
          placeholder="line"
          value={line()}
          onInput={(e) => setLine(e.currentTarget.value)}
        />
        <input
          class="ws-text-input"
          placeholder="Add a comment on this file…"
          value={body()}
          onInput={(e) => setBody(e.currentTarget.value)}
          onKeyDown={(e) => e.key === "Enter" && void add()}
        />
        <button class="secondary-action" onClick={() => void add()}>Add</button>
      </div>
    </div>
  );
}

function FileView(props: { workspace: string; path: string }) {
  const [mode, setMode] = createSignal<"diff" | "edit">("diff");
  return (
    <div class="ws-file-view">
      <div class="ws-file-view-header">
        <span class="ws-file-view-path">{props.path}</span>
        <div class="command-center-strip ws-file-view-modes">
          <button
            class="nav-button"
            classList={{ "nav-button-active": mode() === "diff" }}
            onClick={() => setMode("diff")}
          >
            Diff
          </button>
          <button
            class="nav-button"
            classList={{ "nav-button-active": mode() === "edit" }}
            onClick={() => setMode("edit")}
          >
            Edit
          </button>
        </div>
      </div>
      <Show
        when={mode() === "edit"}
        fallback={
          <>
            <DiffView workspace={props.workspace} path={props.path} />
            <FileComments workspace={props.workspace} path={props.path} />
          </>
        }
      >
        <FileEditor workspace={props.workspace} path={props.path} />
      </Show>
    </div>
  );
}

// Commit view — a single commit's stat+patch (git show), rendered with the same
// Diff component as file diffs.
function CommitView(props: { workspace: string; commit: string; onClose: () => void }) {
  const [diff] = createResource(
    () => [props.workspace, props.commit] as const,
    async ([ws, commit]) => {
      try {
        const res = await send({ type: "get_commit_diff", workspace: ws, commit });
        return res.type === "commit_diff" ? res.diff : "";
      } catch {
        return "";
      }
    },
  );
  return (
    <div class="ws-file-view">
      <div class="ws-file-view-header">
        <span class="ws-file-view-path">Commit {props.commit}</span>
        <button class="ui-button-icon" title="Close" onClick={props.onClose}>
          <Icon name="x" />
        </button>
      </div>
      <div class="ws-diff-view">
        <Show when={!diff.loading} fallback={<div class="empty-state">Loading…</div>}>
          <Show when={(diff() ?? "").trim()} fallback={<div class="empty-state">No diff</div>}>
            <Diff text={diff()!} />
          </Show>
        </Show>
      </div>
    </div>
  );
}

type CenterView =
  | { kind: "chat" }
  | { kind: "file"; path: string }
  | { kind: "commit"; commit: string };

export default function ChatSurface(props: { workspace: string }) {
  // Only agent chats (codex/claude) belong in the tab strip. "shell" sessions
  // are the terminal dock, not chats — hide any legacy shell-provider threads.
  const threads = createMemo(() =>
    threadsStore.list(props.workspace).filter((t) => t.provider !== "shell"),
  );
  const [openFilePath, setOpenFilePath] = createSignal<string | null>(null);
  const [view, setView] = createSignal<CenterView>({ kind: "chat" });
  const [newProvider, setNewProvider] = createSignal<string>(prefsStore.state.defaultProvider);
  // threadId -> model to apply once that (freshly created) chat's session is live.
  const [pendingSeed, setPendingSeed] = createSignal<Record<number, string>>({});
  function clearSeed(threadId: number) {
    setPendingSeed((p) => {
      if (!(threadId in p)) return p;
      const { [threadId]: _drop, ...rest } = p;
      return rest;
    });
  }

  // Let the right-panel Browse/Changes open files into the center.
  onMount(() => registerOpenFile((ws, path) => {
    if (ws !== props.workspace) return;
    openFile(path);
  }));
  // Let the recent-commits list open a commit's diff into the center.
  onMount(() => registerOpenCommit((ws, commit) => {
    if (ws !== props.workspace) return;
    setView({ kind: "commit", commit });
  }));

  function openFile(path: string) {
    setOpenFilePath(path);
    setView({ kind: "file", path });
  }
  function closeFile(path: string) {
    if (openFilePath() === path) setOpenFilePath(null);
    setView((v) => (v.kind === "file" && v.path === path ? { kind: "chat" } : v));
  }

  createEffect(
    on(
      () => props.workspace,
      (ws) => {
        setOpenFilePath(null);
        setView({ kind: "chat" });
        void threadsStore.refresh(ws).then((all) => {
          const list = all.filter((t) => t.provider !== "shell");
          // Every workspace always has at least one chat thread: if none exist
          // yet (freshly created, or all closed), create one so the chat UI is
          // never empty. The live agent session starts on send, not on
          // selection, so other workspace surfaces stay responsive.
          if (list.length === 0) {
            void newChat();
            return;
          }
          const current = nav.selectedChatThread();
          if (current == null || !list.some((t) => t.id === current)) {
            selectThread(list[0]);
          }
        });
      },
    ),
  );

  function selectThread(thread: ArchcarChatThread) {
    nav.selectChatThread(thread.id);
    chatStore.setCompletedTurnAttention(thread.id, false);
    setView({ kind: "chat" });
    loadThread(thread.id);
  }

  const activeThread = createMemo(() => threads().find((t) => t.id === nav.selectedChatThread()));

  async function newChat(provider?: string) {
    const chosen = provider ?? newProvider();
    setNewProvider(chosen);
    try {
      const res = await send({
        type: "create_chat_thread",
        workspace: props.workspace,
        provider: chosen,
        title: "New chat",
      });
      const list = await threadsStore.refresh(props.workspace);
      if (res.type === "chat_thread_created") {
        // Seed the new chat with the default model so it opens ready to run.
        const seed = prefsStore.seedModelFor(chosen);
        if (seed) setPendingSeed((p) => ({ ...p, [res.thread.id]: seed }));
        const created = list.find((t) => t.id === res.thread.id);
        if (created) selectThread(created);
      }
    } catch {
      // non-fatal
    }
  }

  onMount(() => {
    const onNewChat = () => void newChat();
    window.addEventListener("archductor:new-chat", onNewChat);
    onCleanup(() => window.removeEventListener("archductor:new-chat", onNewChat));
  });

  async function closeThread(thread: ArchcarChatThread) {
    try {
      await send({ type: "close_chat_thread", thread_id: thread.id });
      const all = await threadsStore.refresh(props.workspace);
      const list = all.filter((t) => t.provider !== "shell");
      // A workspace always keeps at least one chat: closing the last one opens a
      // fresh one rather than dropping to an empty surface.
      if (list.length === 0) {
        void newChat();
        return;
      }
      if (nav.selectedChatThread() === thread.id) {
        nav.selectChatThread(list[0].id);
      }
    } catch {
      // non-fatal
    }
  }

  return (
    <div class="chat-surface">
      <div class="ws-chat-tab-bar ws-tab-bar">
        <div class="ws-chat-tabs-scroll">
          <div class="ws-chat-tabs">
          <Show when={openFilePath()}>
            {(path) => (
              <FileTab
                path={path()}
                active={view().kind === "file" && (view() as { path: string }).path === path()}
                onClick={() => setView({ kind: "file", path: path() })}
                onClose={() => closeFile(path())}
              />
            )}
          </Show>
          <For each={threads()}>
            {(thread, i) => (
              <ThreadTab
                thread={thread}
                label={`Chat ${i() + 1}`}
                queued={chatStore.slice(thread.id).queue.length}
                pendingInteraction={interactionsStore.pending(thread.id) != null}
                active={view().kind === "chat" && nav.selectedChatThread() === thread.id}
                onClick={() => selectThread(thread)}
                onClose={() => void closeThread(thread)}
              />
            )}
          </For>
            <Show when={threads().length === 0 && openFilePath() == null}>
              <span class="empty-label">Starting chat in {titleCaseWorkspace(props.workspace)}…</span>
            </Show>
          </div>
        </div>
        {/* Pinned outside the scroller: opening a new chat must not require
            scrolling past every tab you already have. */}
        <button class="ui-button-icon ws-chat-new" title="New chat" onClick={() => void newChat()}>
          <Icon name="plus" />
        </button>
      </div>
      <Switch fallback={<div class="empty-state">Starting chat…</div>}>
        <Match when={view().kind === "commit"}>
          <CommitView
            workspace={props.workspace}
            commit={(view() as { commit: string }).commit}
            onClose={() => setView({ kind: "chat" })}
          />
        </Match>
        <Match when={view().kind === "file"}>
          <FileView workspace={props.workspace} path={(view() as { path: string }).path} />
        </Match>
        <Match when={view().kind === "chat" && activeThread()}>
          <Timeline threadId={activeThread()!.id} workspace={props.workspace} />
          <Show when={interactionsStore.pending(activeThread()!.id)}>
            {(rec) => (
              <Show
                when={rec().kind === "plan_approval"}
                fallback={<InteractionBanner rec={rec()} />}
              >
                <PlanCard rec={rec()} />
              </Show>
            )}
          </Show>
          <Composer
            threadId={activeThread()!.id}
            workspace={props.workspace}
            provider={activeThread()!.provider}
            seedModel={pendingSeed()[activeThread()!.id]}
            onSeeded={() => clearSeed(activeThread()!.id)}
            onChangeProvider={(p) => {
              if (p !== activeThread()!.provider) void newChat(p);
            }}
          />
        </Match>
      </Switch>
    </div>
  );
}
