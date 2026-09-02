import { Show, createEffect, createMemo, createResource, createSignal, onCleanup, untrack } from "solid-js";
import {
  chatStore,
  interactionsStore,
  actions,
  prefsStore,
  newChatContextStore,
} from "@/store";
import { EFFORTS, agentModelOptions, agentModelValue, firstModel, providerForModel } from "@/lib/models";
import {
  rankSkills,
  skillMentionAt,
  skillsForProvider,
  type SkillOption
} from "@/lib/skillMention";
import { send } from "@/bridge/client";
import { titleCaseWorkspace } from "@/lib/text";
import CompactSelect from "@/components/CompactSelect";
import RichInput, { type RichInputApi } from "@/components/RichInput";
import {
  fromVisible,
  normalize,
  toInput,
  toVisible,
  type ComposerNode,
} from "@/lib/composerDocument";
import { composerPrimaryAction } from "@/lib/composerPrimaryAction";
import { parseKeybindingOverrides, resolveShortcut } from "@/lib/shortcuts";
import {
  contextPreamble,
} from "@/lib/newChatContext";
import {
  chatGenerationState,
  generationLabel,
  showsGenerationLoader,
  type ChatGenerationState
} from "@/lib/chatGeneration";
import { inlineFileMentionAt } from "@/lib/chatAttachments";
import { fuzzyScore } from "@/lib/fuzzy";
import { providerToKind } from "./providerKind";
import {
  ComposerErrorBanner,
  ComposerQueue,
  ComposerSendButton,
  ComposerStatus,
  ComposerToggle,
  MentionMenu,
} from "./composer/ComposerParts";

// Distinguishes optimistic messages appended in the same millisecond. Local
// to this module: nothing outside the composer creates them.
let optimisticMessageSeq = 0;

// The prompt composer: input, attachments, @-mentions, model/effort controls,
// the send/interrupt action, and the queue of inputs waiting on a busy agent.
/** Message for a failed send/start, kept short enough for the banner line. */
function sendErrorText(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  const text = raw.trim();
  return text.length > 0 ? text : "The agent could not be reached.";
}

export function Composer(props: {
  threadId: number;
  workspace: string;
  provider: string;
  currentModel?: string | null;
  currentEffortMode?: string | null;
  currentFastMode?: boolean;
  onChangeAgentModel: (provider: string, model: string) => void;
  // Model to apply to this chat's session once it first becomes ready. Set only
  // for freshly created chats so existing chats keep their own model choice.
  seedModel?: string;
  onSeeded?: () => void;
}) {
  // The composer's document. `text()` is its visible form — the same string the
  // composer used to hold directly — so everything downstream of it is
  // unchanged; what a string cannot hold is a chip, which is why the document
  // is the source of truth now and the string is derived from it.
  const [nodes, setNodes] = createSignal<ComposerNode[]>([]);
  const text = () => toVisible(nodes());
  let input: RichInputApi | undefined;
  const [fileMention, setFileMention] = createSignal<{ start: number; end: number; query: string } | null>(null);
  const [fileMentionCursor, setFileMentionCursor] = createSignal(0);
  const [skillMention, setSkillMention] = createSignal<{ start: number; end: number; query: string } | null>(null);
  const [skillMentionCursor, setSkillMentionCursor] = createSignal(0);
  const slice = () => chatStore.slice(props.threadId);
  const sessionKind = () => providerToKind(props.provider);
  const running = () => slice().session?.runtime_state === "running";
  // Same derivation the timeline loader uses, so the toolbar chip and the
  // loader can never disagree about whether the agent is working. Note this
  // one is NOT blocked-aware: `awaitingUser` is rendered as its own chip just
  // above, and the two Shows are already mutually exclusive.
  const generation = createMemo<ChatGenerationState>(() =>
    chatGenerationState({
      session: slice().session,
      phase: slice().phase,
      blockedOnUser: false
    }),
  );
  const busyStatusLabel = () => generationLabel(generation(), slowStart());
  const busyStatusTitle = () =>
    generation() === "generating"
      ? "Agent is generating"
      : slowStart()
        ? "Agent is still starting"
        : "Agent starting";
  const sessionId = () => slice().session?.session_id ?? null;
  const modelOptions = agentModelOptions;
  const [workspaceFiles] = createResource(
    () => props.workspace,
    async (workspace): Promise<string[]> => {
      try {
        const res = await send({ type: "list_workspace_files", workspace });
        return res.type === "workspace_files" ? res.files : [];
      } catch {
        return [];
      }
    },
  );
  const fileMentionOptions = createMemo(() => {
    const mention = fileMention();
    if (!mention) return [];
    const query = mention.query.trim();
    const scored = (workspaceFiles() ?? [])
      .slice(0, 1000)
      .map((path) => ({ path, score: fuzzyScore(query, path) }))
      .filter((item): item is { path: string; score: number } => item.score !== null);
    scored.sort((a, b) => a.score - b.score);
    return scored.slice(0, 8).map((item) => item.path);
  });
  // Skills live on the daemon's machine, so they come over the wire like the
  // workspace file list rather than being read locally.
  const [skills] = createResource(
    () => props.threadId,
    async (): Promise<SkillOption[]> => {
      try {
        const res = await send({ type: "list_skills" });
        return res.type === "skills" ? res.skills : [];
      } catch {
        return [];
      }
    },
  );
  const skillMentionOptions = createMemo(() => {
    const mention = skillMention();
    if (!mention) return [];
    const provider = props.provider || null;
    return rankSkills(skillsForProvider(skills() ?? [], provider), mention.query);
  });

  // Readiness watchdog: a session that never reports ready (e.g. the agent CLI
  // hangs on a first-run prompt) shouldn't read as an infinite "starting…" dead
  // end. After a grace period we say so plainly — sending still works, since a
  // message typed while starting is queued and delivered once the turn goes idle.
  const [slowStart, setSlowStart] = createSignal(false);
  createEffect(() => {
    if (generation() === "idle") {
      setSlowStart(false);
      return;
    }
    const timer = setTimeout(() => setSlowStart(true), 15000);
    onCleanup(() => clearTimeout(timer));
  });

  const [model, setModel] = createSignal(props.seedModel || props.currentModel || firstModel(props.provider));
  const [effort, setEffort] = createSignal(props.currentEffortMode || "high");
  const [fastMode, setFastMode] = createSignal(Boolean(props.currentFastMode));

  createEffect(() => {
    const threadId = props.threadId;
    const provider = props.provider;
    const candidate = props.currentModel || props.seedModel || untrack(model);
    const next = candidate && providerForModel(candidate) === provider ? candidate : firstModel(provider);
    void threadId;
    setModel(next);
    setEffort(props.currentEffortMode || "high");
    setFastMode(Boolean(props.currentFastMode));
  });

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
      source: "desktop_optimistic"
    });
    return id;
  }

  function changeModel(next: string) {
    setModel(next);
    const sid = sessionId();
    if (sid != null) void send({ type: "set_session_model", session_id: sid, model: next }).catch(() => {});
  }
  function changeAgentModel(next: string) {
    const option = modelOptions().find((entry) => entry.value === next);
    if (!option) return;
    if (option.provider !== props.provider) {
      props.onChangeAgentModel(option.provider, option.model);
      return;
    }
    changeModel(option.model);
  }
  function changeEffort(next: string) {
    setEffort(next);
    const sid = sessionId();
    if (sid != null) void send({ type: "set_session_effort", session_id: sid, effort: next }).catch(() => {});
  }
  function toggleFastMode() {
    const next = !fastMode();
    setFastMode(next);
    const sid = sessionId();
    if (sid != null) void send({ type: "set_session_fast_mode", session_id: sid, fast_mode: next }).catch(() => {});
  }

  const PASTE_TO_FILE_CHARS = 2000;

  // The mention parsers take `(value, cursor)` against a flat string and are
  // already tested against it, so the caret is converted to an index into
  // `text()` rather than the parsers being rewritten against the DOM.
  function syncFileMention(value = text(), cursor = input?.caret() ?? value.length) {
    setFileMention(inlineFileMentionAt(value, cursor));
    setFileMentionCursor(0);
    setSkillMention(skillMentionAt(value, cursor));
    setSkillMentionCursor(0);
  }

  function setEditorNodes(next: ComposerNode[], cursor?: number) {
    const document_ = normalize(next);
    setNodes(document_);
    queueMicrotask(() => {
      input?.setNodes(document_, cursor);
      syncFileMention(toVisible(document_), cursor);
    });
  }

  /**
   * Replace the typed `@query` (or `/query`) with a chip.
   *
   * The chip goes in as a node rather than as marker text that something later
   * re-reads as a chip: it is the thing itself from the moment it is picked.
   */
  function insertChip(range: { start: number; end: number }, chip: ComposerNode, trailing = " ") {
    const value = text();
    const before = value.slice(0, range.start);
    const after = value.slice(range.end);
    const head = fromVisible(before);
    const tail = fromVisible(after.startsWith(" ") ? after.slice(1) : after);
    const next = normalize([...head, chip, { kind: "text", text: trailing }, ...tail]);
    setEditorNodes(next, toVisible([...head, chip]).length + trailing.length);
  }

  function insertFileAttachment(path: string, range = fileMention()) {
    if (!range) return;
    setFileMention(null);
    insertChip(range, { kind: "file", path, label: fileNameFromMention(path) });
  }

  /** Insert `/name` — the agent CLI is what actually runs the command. */
  function insertSkill(name: string) {
    const mention = skillMention();
    if (!mention) return;
    setSkillMention(null);
    insertChip(mention, { kind: "command", name });
  }

  function fileNameFromMention(path: string): string {
    return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
  }

  // Combine typed text with inline pasted-file markers and context picked on
  // the empty-chat screen. `input` (to the agent) swaps visible {file.md}
  // markers for @path references; `visible` keeps the compact inline markers.
  function buildPayload(): { input: string; visible: string } | null {
    const value = text().trim();
    if (!value) return null;
    const picks = newChatContextStore.picks(props.threadId);
    const inputText = toInput(nodes()).trim();
    const input = [contextPreamble(picks), inputText].filter(Boolean).join("\n\n");
    const visible = [
      value,
      ...picks.map((pick) => `{${pick.label}}`),
    ]
      .filter(Boolean)
      .join("  ");
    return { input, visible };
  }

  function clearComposer() {
    setEditorNodes([]);
    setFileMention(null);
    setSkillMention(null);
    // Picked context rides on one message only; a follow-up shouldn't resend it.
    newChatContextStore.clear(props.threadId);
  }

  // Large paste → save to a workspace file and insert a chip for it, instead of
  // dumping thousands of characters into the input. `insert` is RichInput's
  // plain-text insertion, used for everything that is not a big paste.
  async function onPaste(e: ClipboardEvent, insert: (value: string) => void) {
    const pasted = e.clipboardData?.getData("text") ?? "";
    if (pasted.length <= PASTE_TO_FILE_CHARS) {
      insert(pasted);
      return;
    }
    const caret = input?.caret() ?? text().length;
    try {
      const res = await send({ type: "save_chat_paste", thread_id: props.threadId, text: pasted });
      if (res.type === "chat_paste_saved") {
        insertChip({ start: caret, end: caret }, {
          kind: "file",
          path: res.relative_path,
          label: res.label,
        });
      } else {
        insert(pasted);
      }
    } catch {
      insert(pasted);
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
    const prevNodes = nodes();
    const prevPicks = newChatContextStore.picks(props.threadId);
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
        session_kind: sessionKind()
      });
      if (res.type === "error") throw new Error(res.message);
    } catch (err) {
      chatStore.setPhase(props.threadId, { kind: "failed", message: sendErrorText(err) });
      setEditorNodes(prevNodes);
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
    const prevNodes = nodes();
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
        delivery: "immediate"
      });
      if (res.type === "error") throw new Error(res.message);
    } catch (err) {
      chatStore.removeOptimistic(props.threadId, pendingId);
      chatStore.setPhase(props.threadId, { kind: "failed", message: sendErrorText(err) });
      setEditorNodes(prevNodes);
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
        kind: sessionKind()
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
  // Send a queued item now, then drop it from the queue.
  async function steerQueued(q: { id: number; input: string; visible_input?: string }) {
    const sid = sessionId();
    if (sid == null) return;
    try {
      await send({
        type: "send_input",
        session_id: sid,
        input: q.input,
        visible_input: q.visible_input,
        kind: "user",
        delivery: "immediate"
      });
      // Only drop from the queue once delivery succeeded — otherwise a failed
      // send would silently discard the user's message.
      await removeQueued(q.id);
    } catch {
      // keep the item queued so the user can retry
    }
  }

  function onKeyDown(e: KeyboardEvent) {
    if (skillMention() && skillMentionOptions().length > 0) {
      const n = skillMentionOptions().length;
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSkillMentionCursor((c) => (c + 1) % n);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setSkillMentionCursor((c) => (c - 1 + n) % n);
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        insertSkill(skillMentionOptions()[skillMentionCursor()].name);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setSkillMention(null);
        return;
      }
    }
    if (fileMention()) {
      const n = fileMentionOptions().length;
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setFileMentionCursor((c) => (n === 0 ? 0 : (c + 1) % n));
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setFileMentionCursor((c) => (n === 0 ? 0 : (c - 1 + n) % n));
        return;
      }
      if ((e.key === "Enter" || e.key === "Tab") && n > 0) {
        e.preventDefault();
        insertFileAttachment(fileMentionOptions()[fileMentionCursor()]);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setFileMention(null);
        return;
      }
    }
    // Deleting a chip whole used to be hand-rolled here against the string.
    // A chip is a `contenteditable="false"` element now, so the browser does it.
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
    const prevNodes = nodes();
    clearComposer();
    await actions
      .resolveInteraction(plan.id, { type: "deny", reason: feedback })
      .catch((err) => {
        setEditorNodes(prevNodes);
        chatStore.setPhase(props.threadId, { kind: "failed", message: sendErrorText(err) });
      });
  }

  return (
    <div class="chat-composer">
      <Show when={failure()}>
        {(message) => (
          <ComposerErrorBanner
            message={message()}
            onRetry={() => void retrySession()}
            onDismiss={() => chatStore.setPhase(props.threadId, { kind: "ready" })}
          />
        )}
      </Show>
      <Show when={slice().queue.length > 0}>
        <ComposerQueue
          queue={slice().queue}
          canSteer={sessionId() != null}
          onMove={(id, up) => void moveQueued(id, up)}
          onSteer={(q) => void steerQueued(q)}
          onRemove={(id) => void removeQueued(id)}
        />
      </Show>
      <div class="chat-composer-box">
        <div class="chat-input-shell">
          <RichInput
            ref={(api) => (input = api)}
            nodes={nodes}
            placeholder={
              pendingPlan()
                ? "What should change in the plan?"
                : planMode()
                  ? "Describe what to plan — the agent researches, then proposes"
                  : "Ask to make changes, @mention files, run /commands"
            }
            onInput={(next, caret) => {
              setNodes(next);
              syncFileMention(toVisible(next), caret);
            }}
            onKeyDown={onKeyDown}
            onPaste={(e, insert) => void onPaste(e, insert)}
          />
          <Show when={skillMention() && skillMentionOptions().length > 0}>
            <MentionMenu
              class="chat-skill-menu"
              items={skillMentionOptions()}
              cursor={skillMentionCursor()}
              onHover={setSkillMentionCursor}
              onPick={(skill) => insertSkill(skill.name)}
              renderItem={(skill) => (
                <>
                  <span class="chat-file-mention-name">/{skill.name}</span>
                  <span class="chat-file-mention-path chat-skill-description">{skill.description}</span>
                </>
              )}
            />
          </Show>
          <Show when={fileMention() && fileMentionOptions().length > 0}>
            <MentionMenu
              items={fileMentionOptions()}
              cursor={fileMentionCursor()}
              onHover={setFileMentionCursor}
              onPick={(path) => insertFileAttachment(path)}
              renderItem={(path) => (
                <>
                  <span class="chat-file-mention-name">{fileNameFromMention(path)}</span>
                  <span class="chat-file-mention-path">{path}</span>
                </>
              )}
            />
          </Show>
        </div>
        <div class="chat-toolbar">
          <div class="chat-toolbar-left">
            {/* Agent/model is one choice: switching providers opens a new chat
                with the selected model, while same-provider changes update the
                current live session. */}
            <CompactSelect
              title="Agent and model"
              value={agentModelValue(props.provider, model())}
              options={modelOptions()}
              onChange={changeAgentModel}
              icon="settings"
              class="compact-select-agent-model"
            />
            <CompactSelect
              title="Reasoning effort"
              value={effort()}
              options={EFFORTS.map((x) => ({ value: x, label: titleCaseWorkspace(x) }))}
              onChange={changeEffort}
              icon="brain"
              class="chat-effort-select"
            />
            <ComposerToggle
              on={fastMode()}
              icon="bolt"
              label="Fast"
              title={fastMode() ? "Fast mode on" : "Fast mode off"}
              onClick={() => toggleFastMode()}
            />
            {/* Plan mode is provider-native: claude runs in its plan permission
                mode, codex plans inside a read-only sandbox. */}
            <ComposerToggle
              on={planMode()}
              icon="file-text"
              label="Plan"
              title={
                planMode() ? "Planning — approve a plan to start building" : "Plan before building"
              }
              onClick={() => void togglePlanMode()}
            />
          </div>
          <div class="chat-toolbar-right">
            <ComposerStatus
              contextPercent={contextPercent()}
              awaitingUser={awaitingUser()}
              busy={showsGenerationLoader(generation())}
              busyLabel={busyStatusLabel()}
              busyTitle={busyStatusTitle()}
            />
            <ComposerSendButton
              interrupting={composerPrimaryAction(running()) === "interrupt"}
              hasText={text().trim().length > 0}
              onActivate={primaryAction}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

