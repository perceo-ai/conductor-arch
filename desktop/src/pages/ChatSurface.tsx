import { For, Match, Show, Switch, createEffect, createMemo, createSignal, on } from "solid-js";
import { chatStore, threadsStore, nav, loadThread } from "@/store";
import { send } from "@/bridge/client";
import type { ArchcarChatThread, ArchcarProjectionItem, SessionKind } from "@/bridge/protocol";
import { titleCaseWorkspace } from "@/lib/text";

// Chat surface — port of session_surface.rs. Thread tab strip + projected
// timeline + composer. The projected timeline is built in core
// (provider_projection_from_records, exposed via get_chat_projection) so
// streaming/dedup logic lives in one place; this file only maps render_class to
// a component. Persisted messages are the fallback when no provider events exist
// (older threads).
//
// Rerender control: the timeline reads chatStore.slice(thread).projection, a
// store keyed by item id. A streaming delta reconciles one item → one card
// re-renders, not the whole list.

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

function UserBubble(props: { body: string }) {
  return (
    <div class="chat-user-row">
      <div class="chat-user-bubble">{props.body}</div>
    </div>
  );
}

// Render a diff/patch body with per-line +/- coloring (mirrors the GTK
// inline-event code rows).
function DiffBody(props: { body: string }) {
  const lines = () => props.body.replace(/\n$/, "").split("\n");
  return (
    <div class="chat-inline-event-code chat-inline-event-code-rows">
      <For each={lines()}>
        {(line) => {
          const added = line.startsWith("+") && !line.startsWith("+++");
          const removed = line.startsWith("-") && !line.startsWith("---");
          const hunk = line.startsWith("@@");
          return (
            <div
              class="chat-inline-event-code-row"
              classList={{
                "chat-inline-event-code-row-added": added,
                "chat-inline-event-code-row-removed": removed,
                "chat-inline-event-code-row-hunk": hunk,
                "chat-inline-event-code-row-context": !added && !removed && !hunk,
              }}
            >
              <span class="chat-inline-event-code-sign">{added ? "+" : removed ? "-" : ""}</span>
              <span class="chat-inline-event-code-text">
                {added || removed ? line.slice(1) : line}
              </span>
            </div>
          );
        }}
      </For>
    </div>
  );
}

// Non-chat projection item (command/tool/diff/file/plan/reasoning/status/…)
// rendered as a collapsible inline-event card, styled by render class.
function InlineCard(props: { item: ArchcarProjectionItem }) {
  const [open, setOpen] = createSignal(true);
  const cls = () => props.item.render_class;
  const label = () => props.item.title || cls().replace(/_card$/, "").replace(/_/g, " ");
  const isDiff = () => cls() === "diff_card";
  const isTerminal = () => cls() === "command_card" || cls() === "process_card";
  return (
    <div
      class="chat-inline-event"
      classList={{
        "chat-inline-event-failed": props.item.status === "failed",
        "chat-inline-event-loading": props.item.status === "running",
      }}
    >
      <button class="chat-inline-event-action" onClick={() => setOpen((o) => !o)}>
        <span class="chat-inline-event-expander">{open() ? "▾" : "▸"}</span>
        {label()}
      </button>
      <Show when={open() && props.item.body.trim()}>
        <Switch fallback={<div class="chat-inline-event-body">{props.item.body}</div>}>
          <Match when={isDiff()}>
            <DiffBody body={props.item.body} />
          </Match>
          <Match when={isTerminal()}>
            <pre class="chat-inline-event-terminal">{props.item.body}</pre>
          </Match>
        </Switch>
      </Show>
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
        <div class="chat-agent-text">{props.item.body}</div>
      </Match>
      <Match when={cls() === "reasoning_card"}>
        <div class="chat-reasoning-text">{props.item.body}</div>
      </Match>
    </Switch>
  );
}

function Timeline(props: { threadId: number }) {
  const slice = () => chatStore.slice(props.threadId);
  // Projection is the spine when present; fall back to persisted messages.
  const items = createMemo<ArchcarProjectionItem[]>(() => {
    const s = slice();
    if (s.projection.length > 0) return s.projection;
    return s.messages.map((m) => ({
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

function Composer(props: { threadId: number; sessionKind: SessionKind }) {
  const [text, setText] = createSignal("");
  const slice = () => chatStore.slice(props.threadId);
  const busy = () => slice().session?.ready === false && slice().session != null;

  async function submit() {
    const value = text().trim();
    if (!value) return;
    setText("");
    try {
      await send({
        type: "queue_chat_input",
        thread_id: props.threadId,
        input: value,
        kind: "user",
        session_kind: props.sessionKind,
      });
    } catch {
      // restore text on failure so the user doesn't lose it
      setText(value);
    }
  }

  function onKeyDown(e: KeyboardEvent) {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      void submit();
    }
  }

  return (
    <div class="chat-composer">
      <Show when={slice().queue.length > 0}>
        <div class="chat-queue-overlay">
          <For each={slice().queue}>
            {(q) => (
              <div class="chat-queued-composer-row">
                <span class="chat-queued-composer-body">{q.visible_input ?? q.input}</span>
              </div>
            )}
          </For>
        </div>
      </Show>
      <div class="chat-composer-box">
        <div class="chat-input-shell">
          <textarea
            class="chat-input-view"
            placeholder="Ask to make changes, @mention files, or run /commands"
            value={text()}
            onInput={(e) => setText(e.currentTarget.value)}
            onKeyDown={onKeyDown}
            rows={2}
          />
        </div>
        <div class="chat-toolbar">
          <div class="chat-toolbar-left" />
          <div class="chat-toolbar-right">
            <span class="chat-status-hint">{busy() ? "working…" : "⌘/Ctrl+Enter to send"}</span>
            <button
              class="chat-send-btn"
              classList={{ "chat-send-btn-active": text().trim().length > 0 }}
              onClick={() => void submit()}
              title="Send"
            >
              ⏎
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

export default function ChatSurface(props: { workspace: string }) {
  const threads = createMemo(() => threadsStore.list(props.workspace));

  // Load threads when the workspace changes.
  createEffect(
    on(
      () => props.workspace,
      (ws) => {
        void threadsStore.refresh(ws).then((list) => {
          if (list.length === 0) return;
          // Select the first thread when nothing is selected OR the current
          // selection isn't in this workspace's list (e.g. after switching
          // workspaces the stale thread id must not stick).
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
    // Ensure a live session so streaming works, then load history + projection.
    void send({
      type: "ensure_chat_thread_session",
      workspace: props.workspace,
      thread_id: thread.id,
      kind: providerToKind(thread.provider),
    }).catch(() => {});
    loadThread(thread.id);
  }

  const activeThread = createMemo(() =>
    threads().find((t) => t.id === nav.selectedChatThread()),
  );

  async function newChat() {
    try {
      const res = await send({
        type: "create_chat_thread",
        workspace: props.workspace,
        provider: "codex",
        title: "New chat",
      });
      const list = await threadsStore.refresh(props.workspace);
      if (res.type === "chat_thread_created") {
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
      const list = await threadsStore.refresh(props.workspace);
      if (nav.selectedChatThread() === thread.id) {
        nav.selectChatThread(list.length > 0 ? list[0].id : null);
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
                active={nav.selectedChatThread() === thread.id}
                onClick={() => selectThread(thread)}
                onClose={() => void closeThread(thread)}
              />
            )}
          </For>
          <button class="ui-button-icon ws-chat-new" title="New chat" onClick={() => void newChat()}>
            +
          </button>
          <Show when={threads().length === 0}>
            <span class="empty-label">No chats in {titleCaseWorkspace(props.workspace)} yet</span>
          </Show>
        </div>
      </div>
      <Show
        when={activeThread()}
        fallback={<div class="empty-state">Select or start a chat.</div>}
      >
        {(thread) => (
          <>
            <Timeline threadId={thread().id} />
            <Composer
              threadId={thread().id}
              sessionKind={providerToKind(thread().provider)}
            />
          </>
        )}
      </Show>
    </div>
  );
}
