import { For, Show, createEffect, createMemo, createSignal, on } from "solid-js";
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

function ThreadTab(props: { thread: ArchcarChatThread; active: boolean; onClick: () => void }) {
  const generating = () => props.thread.status === "running" || props.thread.status === "generating";
  return (
    <button
      class="ws-chat-tab-shell ws-tab-shell"
      classList={{ "ws-tab-active": props.active }}
      onClick={props.onClick}
    >
      <span class="ws-chat-tab-dot" classList={{ "ws-chat-tab-spinner": generating() }} />
      <span class="ws-tab-label">{props.thread.title || `Chat ${props.thread.id}`}</span>
    </button>
  );
}

function UserBubble(props: { body: string }) {
  return (
    <div class="chat-user-row">
      <div class="chat-user-bubble">{props.body}</div>
    </div>
  );
}

function TimelineItem(props: { item: ArchcarProjectionItem }) {
  const cls = () => props.item.render_class;
  return (
    <Show
      when={cls() !== "user_chat"}
      fallback={<UserBubble body={props.item.body} />}
    >
      <Show
        when={cls() !== "assistant_chat"}
        fallback={<div class="chat-agent-text">{props.item.body}</div>}
      >
        <Show
          when={cls() !== "reasoning_card"}
          fallback={<div class="chat-reasoning-text">{props.item.body}</div>}
        >
          {/* generic card: command / tool / diff / file / status / … */}
          <div class="chat-inline-event" classList={{ [`is-${props.item.status}`]: true }}>
            <Show when={props.item.title}>
              <div class="chat-inline-event-action">{props.item.title}</div>
            </Show>
            <Show when={props.item.body.trim()}>
              <div class="chat-inline-event-body">{props.item.body}</div>
            </Show>
          </div>
        </Show>
      </Show>
    </Show>
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
          if (list.length > 0 && nav.selectedChatThread() == null) {
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
              />
            )}
          </For>
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
