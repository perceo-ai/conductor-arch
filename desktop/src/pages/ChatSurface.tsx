import { For, Match, Show, Switch, createEffect, createMemo, createSignal, on, onCleanup, onMount } from "solid-js";
import { chatStore, threadsStore, nav, loadThread, interactionsStore, actions, prefsStore } from "@/store";
import { MODELS, EFFORTS } from "@/lib/models";
import { send } from "@/bridge/client";
import type {
  ArchcarChatThread,
  ArchcarProjectionItem,
  ProviderInteractionRecord,
  ProviderInteractionResolution,
  SessionKind,
} from "@/bridge/protocol";
import { titleCaseWorkspace } from "@/lib/text";
import { isDisplayableTimelineItem } from "@/lib/timeline";
import { DiffView } from "./WorkspaceChanges";
import { registerOpenFile } from "./openFileBridge";
import Diff from "@/components/Diff";
import { renderMarkdown } from "@/lib/markdown";
import { ansiToHtml } from "@/lib/ansi";
import { inlineEventVerbChip, isDiffCard, isTerminalCard, stripArchductorMetadata } from "@/lib/chatFormat";

// Chat surface — center panel of the command center. Holds chat tabs + open-file
// tabs, a content stack (chat timeline or a file's diff), and the composer.
// Chats are provider sessions (codex/claude) driven by archcar; the projected
// timeline is built in core (get_chat_projection) so this file only maps
// render_class -> component.

function providerToKind(provider: string): SessionKind {
  if (provider === "codex" || provider === "claude" || provider === "shell") return provider;
  return "codex";
}

function ThreadTab(props: {
  thread: ArchcarChatThread;
  active: boolean;
  onClick: () => void;
  onClose: () => void;
}) {
  const generating = () => props.thread.status === "running" || props.thread.status === "generating";
  return (
    <div
      class="ws-chat-tab-shell ws-tab-shell"
      classList={{ "ws-tab-active": props.active }}
      onClick={props.onClick}
      role="button"
    >
      <span class="ws-chat-tab-dot" classList={{ "ws-chat-tab-spinner": generating() }} />
      <span class="ws-tab-label">{props.thread.title || `Chat ${props.thread.id}`}</span>
      <button
        class="ws-tab-close-button"
        title="Close chat"
        onClick={(e) => {
          e.stopPropagation();
          props.onClose();
        }}
      >
        ×
      </button>
    </div>
  );
}

function FileTab(props: { path: string; active: boolean; onClick: () => void; onClose: () => void }) {
  const name = () => props.path.split("/").pop() ?? props.path;
  return (
    <div
      class="ws-chat-tab-shell ws-tab-shell ws-file-tab"
      classList={{ "ws-tab-active": props.active }}
      onClick={props.onClick}
      role="button"
      title={props.path}
    >
      <span class="ws-file-tab-icon">·</span>
      <span class="ws-tab-label">{name()}</span>
      <button
        class="ws-tab-close-button"
        title="Close file"
        onClick={(e) => {
          e.stopPropagation();
          props.onClose();
        }}
      >
        ×
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

// Inline "chip-card" event — GTK's inline_event_widget: a flat row of expander +
// verb (action label) + a small monospace content chip (the command/filename),
// with the body revealed only on expand. No category badge; the row carries no
// card chrome of its own. Bodies stay collapsed until the user asks for them.
function InlineCard(props: { item: ArchcarProjectionItem }) {
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
        "chat-inline-event-loading": props.item.status === "running",
      }}
    >
      <div class="chat-inline-event-header">
        <button
          class="chat-inline-event-expander"
          title={hasBody() ? "Show details" : undefined}
          disabled={!hasBody()}
          onClick={() => setOpen((o) => !o)}
        >
          {hasBody() ? (open() ? "−" : "+") : "·"}
        </button>
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

// Agent asked for something mid-turn (permission / question / plan approval).
// Rendered above the composer with actionable buttons; resolving it unblocks the
// turn (else tools that require approval silently stall).
function InteractionBanner(props: { rec: ProviderInteractionRecord }) {
  const resolve = (resolution: ProviderInteractionResolution) =>
    void actions.resolveInteraction(props.rec.id, resolution).catch(() => {});
  return (
    <div class="chat-interaction">
      <div class="chat-interaction-head">
        <span class="chat-interaction-kind">{props.rec.kind.replace(/_/g, " ")}</span>
        <span class="chat-interaction-title">{props.rec.title}</span>
      </div>
      <Show when={props.rec.detail.trim()}>
        <div class="chat-interaction-detail">{props.rec.detail}</div>
      </Show>
      <div class="chat-interaction-actions">
        <Show
          when={props.rec.kind === "user_question" && props.rec.choices.length > 0}
          fallback={
            <>
              <button class="ui-button-primary" onClick={() => resolve({ type: "approve" })}>
                Approve
              </button>
              <button class="ui-button-destructive" onClick={() => resolve({ type: "deny" })}>
                Deny
              </button>
            </>
          }
        >
          <For each={props.rec.choices}>
            {(c) => (
              <button class="ui-button-sm" onClick={() => resolve({ type: "answer", answers: [["answer", c]] })}>
                {c}
              </button>
            )}
          </For>
        </Show>
        <button class="ui-button-sm" onClick={() => resolve({ type: "defer" })}>
          Defer
        </button>
      </div>
    </div>
  );
}

function TimelineItem(props: { item: ArchcarProjectionItem }) {
  const cls = () => props.item.render_class;
  return (
    <Switch fallback={<InlineCard item={props.item} />}>
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
        <div class="chat-reasoning-text markdown-body" innerHTML={renderMarkdown(props.item.body)} />
      </Match>
    </Switch>
  );
}

function Timeline(props: { threadId: number }) {
  const slice = () => chatStore.slice(props.threadId);
  const items = createMemo<ArchcarProjectionItem[]>(() => {
    const s = slice();
    const base: ArchcarProjectionItem[] =
      s.projection.length > 0
        ? s.projection
        : s.messages.map((m) => ({
            id: `msg-${m.id}`,
            sequence: m.id,
            render_class:
              m.role === "user" ? "user_chat" : m.role === "system" ? "status_card" : "assistant_chat",
            role_label: m.role,
            title: "",
            body: m.content,
            status: "complete",
            stream_state: "complete",
          }));
    return base.filter(isDisplayableTimelineItem);
  });
  return (
    <div class="chat-timeline-scroll">
      <div class="chat-messages">
        <Show
          when={items().length > 0}
          fallback={<div class="empty-state">No messages yet. Say something below.</div>}
        >
          <For each={items()}>{(item) => <TimelineItem item={item} />}</For>
        </Show>
      </div>
    </div>
  );
}

function Composer(props: {
  threadId: number;
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
  const running = () => slice().session?.runtime_state === "running";
  const sessionId = () => slice().session?.session_id ?? null;
  const models = () => MODELS[props.provider] ?? [];

  // Readiness watchdog: a session that never reports ready (e.g. the agent CLI
  // hangs on a first-run prompt) shouldn't read as an infinite "starting…" dead
  // end. After a grace period we say so plainly — sending still works, since a
  // message typed while starting is queued and delivered once the turn goes idle.
  const [slowStart, setSlowStart] = createSignal(false);
  createEffect(() => {
    if (!busy()) {
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

  // Combine the typed text with any pasted-file references. `input` (to the
  // agent) carries the file paths; `visible` (shown in the UI) gets a compact
  // 📎 marker so the timeline isn't cluttered with paths.
  function buildPayload(): { input: string; visible: string } | null {
    const value = text().trim();
    const atts = attachments();
    if (!value && atts.length === 0) return null;
    const refs = atts.map((a) => `Attached file (${a.label}): ${a.path}`);
    const input = [value, ...refs].filter(Boolean).join("\n\n");
    const visible = [value, ...atts.map((a) => `📎 ${a.label}`)].filter(Boolean).join("  ");
    return { input, visible };
  }

  function clearComposer() {
    setText("");
    setAttachments([]);
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
  async function queueSend() {
    const payload = buildPayload();
    if (!payload) return;
    clearComposer();
    try {
      await send({
        type: "queue_chat_input",
        thread_id: props.threadId,
        input: payload.input,
        visible_input: payload.visible,
        kind: "user",
        session_kind: sessionKind(),
      });
    } catch {
      setText(payload.input);
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
    clearComposer();
    try {
      await send({
        type: "send_input",
        session_id: sid,
        input: payload.input,
        visible_input: payload.visible,
        kind: "user",
        delivery: "immediate",
      });
    } catch {
      setText(payload.input);
    }
  }

  // Stop the active turn.
  async function interrupt() {
    const sid = sessionId();
    if (sid != null) await send({ type: "interrupt_turn", session_id: sid }).catch(() => {});
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
    await send({
      type: "send_input",
      session_id: sid,
      input: q.input,
      visible_input: q.visible_input,
      kind: "user",
      delivery: "immediate",
    }).catch(() => {});
    await removeQueued(q.id);
  }

  function onKeyDown(e: KeyboardEvent) {
    if (e.key !== "Enter" || e.shiftKey) return; // Shift+Enter → newline
    e.preventDefault();
    // Ctrl/Cmd+Enter skips the queue and steers; plain Enter queues.
    if (e.ctrlKey || e.metaKey) void steerSend();
    else void queueSend();
  }

  return (
    <div class="chat-composer">
      <Show when={slice().queue.length > 0}>
        <div class="chat-queue-overlay">
          <For each={slice().queue}>
            {(q) => (
              <div class="chat-queued-composer-row">
                <span class="chat-queued-composer-body">{q.visible_input ?? q.input}</span>
                <div class="chat-queued-actions">
                  <button class="chat-queued-action-btn" title="Move up" onClick={() => void moveQueued(q.id, true)}>
                    ↑
                  </button>
                  <button class="chat-queued-action-btn" title="Move down" onClick={() => void moveQueued(q.id, false)}>
                    ↓
                  </button>
                  <button
                    class="chat-queued-action-btn"
                    title="Send now (steer)"
                    disabled={sessionId() == null}
                    onClick={() => void steerQueued(q)}
                  >
                    ⚡
                  </button>
                  <button
                    class="chat-queued-action-btn"
                    title="Remove queued message"
                    onClick={() => void removeQueued(q.id)}
                  >
                    ×
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
                  <span class="chat-attachment-chip-icon">📎</span>
                  <span class="chat-attachment-chip-label">{a.label}</span>
                  <button
                    class="chat-attachment-chip-remove"
                    title="Remove attachment"
                    onClick={() => setAttachments((list) => list.filter((_, j) => j !== i()))}
                  >
                    ×
                  </button>
                </span>
              )}
            </For>
          </div>
        </Show>
        <div class="chat-input-shell">
          <textarea
            class="chat-input-view"
            placeholder="Ask to make changes, @mention files, or run /commands"
            value={text()}
            onInput={(e) => setText(e.currentTarget.value)}
            onKeyDown={onKeyDown}
            onPaste={(e) => void onPaste(e)}
            rows={2}
          />
        </div>
        <div class="chat-toolbar">
          <div class="chat-toolbar-left">
            {/* Provider lives in the composer (like the old GTK bar). Changing it
                opens a NEW chat with that agent; the current chat keeps its own
                model/session untouched. */}
            <select
              class="chat-picker"
              title="Agent"
              value={props.provider}
              onChange={(e) => props.onChangeProvider(e.currentTarget.value)}
            >
              <option value="codex">codex</option>
              <option value="claude">claude</option>
            </select>
            {/* Model + effort are always shown (even when the provider exposes no
                switchable models yet) so the composer controls stay consistent. */}
            <select
              class="chat-picker"
              title="Model"
              value={model()}
              onChange={(e) => changeModel(e.currentTarget.value)}
            >
              <option value="">model…</option>
              <For each={models()}>{(m) => <option value={m}>{m}</option>}</For>
            </select>
            <select
              class="chat-picker"
              title="Reasoning effort"
              value={effort()}
              onChange={(e) => changeEffort(e.currentTarget.value)}
            >
              <For each={EFFORTS}>{(x) => <option value={x}>{x}</option>}</For>
            </select>
          </div>
          <div class="chat-toolbar-right">
            <Show when={contextPercent() != null}>
              <span class="chat-context-usage" title="Context window used">
                {contextPercent()}% context
              </span>
            </Show>
            <span class="chat-status-hint">
              {running()
                ? "running…"
                : busy()
                  ? slowStart()
                    ? "still starting — messages you send will be queued"
                    : "starting…"
                  : "Enter to queue · ⌘/Ctrl+Enter to steer"}
            </span>
            <Show when={running()}>
              <button
                class="chat-send-btn chat-stop-btn"
                onClick={() => void interrupt()}
                title="Stop (interrupt turn)"
              >
                ⏹
              </button>
            </Show>
            <button
              class="chat-send-btn chat-steer-btn"
              classList={{ "chat-send-btn-active": text().trim().length > 0 }}
              onClick={() => void steerSend()}
              title="Steer now — skip queue (⌘/Ctrl+Enter)"
            >
              ⚡
            </button>
            <button
              class="chat-send-btn"
              classList={{ "chat-send-btn-active": text().trim().length > 0 }}
              onClick={() => void queueSend()}
              title="Queue message (Enter)"
            >
              ⏎
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// File view = the file's diff. There is no read-file RPC, so Edit/Preview modes
// are not available; the diff is the useful, backend-backed view of a file.
function FileView(props: { workspace: string; path: string }) {
  return (
    <div class="ws-file-view">
      <div class="ws-file-view-header">{props.path}</div>
      <DiffView workspace={props.workspace} path={props.path} />
    </div>
  );
}

type CenterView = { kind: "chat" } | { kind: "file"; path: string };

export default function ChatSurface(props: { workspace: string }) {
  // Only agent chats (codex/claude) belong in the tab strip. "shell" sessions
  // are the terminal dock, not chats — hide any legacy shell-provider threads.
  const threads = createMemo(() =>
    threadsStore.list(props.workspace).filter((t) => t.provider !== "shell"),
  );
  const [openFiles, setOpenFiles] = createSignal<string[]>([]);
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

  function openFile(path: string) {
    setOpenFiles((f) => (f.includes(path) ? f : [...f, path]));
    setView({ kind: "file", path });
  }
  function closeFile(path: string) {
    setOpenFiles((f) => f.filter((p) => p !== path));
    setView((v) => (v.kind === "file" && v.path === path ? { kind: "chat" } : v));
  }

  createEffect(
    on(
      () => props.workspace,
      (ws) => {
        setOpenFiles([]);
        setView({ kind: "chat" });
        void threadsStore.refresh(ws).then((all) => {
          const list = all.filter((t) => t.provider !== "shell");
          // Every workspace always has at least one chat: if none exist yet
          // (freshly created, or all closed), start one so the chat UI is never
          // empty.
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
    setView({ kind: "chat" });
    void send({
      type: "ensure_chat_thread_session",
      workspace: props.workspace,
      thread_id: thread.id,
      kind: providerToKind(thread.provider),
    }).catch(() => {});
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
      <div class="ws-chat-tabs-scroll ws-tab-bar">
        <div class="ws-chat-tabs">
          <For each={threads()}>
            {(thread) => (
              <ThreadTab
                thread={thread}
                active={view().kind === "chat" && nav.selectedChatThread() === thread.id}
                onClick={() => selectThread(thread)}
                onClose={() => void closeThread(thread)}
              />
            )}
          </For>
          <button class="ui-button-icon ws-chat-new" title="New chat" onClick={() => void newChat()}>
            +
          </button>
          <Show when={openFiles().length > 0}>
            <span class="ws-tab-sep-v" />
          </Show>
          <For each={openFiles()}>
            {(path) => (
              <FileTab
                path={path}
                active={view().kind === "file" && (view() as { path: string }).path === path}
                onClick={() => setView({ kind: "file", path })}
                onClose={() => closeFile(path)}
              />
            )}
          </For>
          <Show when={threads().length === 0 && openFiles().length === 0}>
            <span class="empty-label">Starting chat in {titleCaseWorkspace(props.workspace)}…</span>
          </Show>
        </div>
      </div>
      <Switch fallback={<div class="empty-state">Starting chat…</div>}>
        <Match when={view().kind === "file"}>
          <FileView workspace={props.workspace} path={(view() as { path: string }).path} />
        </Match>
        <Match when={view().kind === "chat" && activeThread()}>
          <Timeline threadId={activeThread()!.id} />
          <Show when={interactionsStore.pending(activeThread()!.id)}>
            {(rec) => <InteractionBanner rec={rec()} />}
          </Show>
          <Composer
            threadId={activeThread()!.id}
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
