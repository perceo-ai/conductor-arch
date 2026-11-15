import { For, Show, createEffect, createSignal, onCleanup } from "solid-js";
import { Portal } from "solid-js/web";
import { send } from "@/bridge/client";
import type { ArchcarChatThread } from "@/bridge/protocol";
import { relativeTime } from "@/lib/relativeTime";
import Icon from "@/components/Icon";

/**
 * Restore picker for closed chats, pinned beside the new-chat button.
 *
 * Closing a chat in archcar only marks the row (`status='closed'` plus
 * `archived_at`) — every message, tool call and provider event survives — but
 * the tab strip filters closed chats out, so until this menu existed a chat
 * closed by a mis-keyed shortcut was unreachable from the app. The list is
 * fetched when the menu opens rather than kept in the store: it is read once,
 * at the moment something has to come back.
 */
export function ClosedChatsMenu(props: {
  workspace: string;
  onRestored: (threadId: number) => void;
}) {
  const [open, setOpen] = createSignal(false);
  const [threads, setThreads] = createSignal<ArchcarChatThread[] | null>(null);
  const [anchor, setAnchor] = createSignal<DOMRect | null>(null);
  let trigger: HTMLButtonElement | undefined;
  let menu: HTMLDivElement | undefined;

  createEffect(() => {
    if (!open()) return;
    const onPointer = (event: PointerEvent) => {
      const target = event.target as Node;
      // The menu is portalled to <body>, so a contains() check on the trigger's
      // own wrapper would dismiss it on its first click.
      if (trigger?.contains(target) || menu?.contains(target)) return;
      setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("pointerdown", onPointer);
    window.addEventListener("keydown", onKey);
    onCleanup(() => {
      window.removeEventListener("pointerdown", onPointer);
      window.removeEventListener("keydown", onKey);
    });
  });

  const menuStyle = () => {
    const rect = anchor();
    if (!rect) return {};
    return {
      position: "fixed" as const,
      top: `${rect.bottom + 5}px`,
      // Right-aligned to the trigger: the button sits at the right edge of the
      // tab bar, so a left-aligned menu would hang off the window.
      right: `${Math.max(8, window.innerWidth - rect.right)}px`,
    };
  };

  async function toggle() {
    if (open()) {
      setOpen(false);
      return;
    }
    if (trigger) setAnchor(trigger.getBoundingClientRect());
    setThreads(null);
    setOpen(true);
    try {
      const res = await send({
        type: "list_closed_chat_threads",
        workspace: props.workspace,
      });
      setThreads(res.type === "chat_threads" ? res.threads : []);
    } catch {
      setThreads([]);
    }
  }

  async function restore(thread: ArchcarChatThread) {
    try {
      await send({ type: "reopen_chat_thread", thread_id: thread.id });
    } catch {
      return;
    }
    setOpen(false);
    props.onRestored(thread.id);
  }

  return (
    <div class="ws-closed-chats">
      <button
        class="ui-button-icon ws-chat-restore"
        ref={trigger}
        aria-label="Restore closed chat"
        title="Restore closed chat"
        aria-haspopup="menu"
        aria-expanded={open()}
        onClick={() => void toggle()}
      >
        <Icon name="history" />
      </button>
      <Show when={open()}>
        {/* Portalled for the same reason as the model picker: the tab bar's
            scroller would clip a menu rendered in place. */}
        <Portal>
          <div class="ws-closed-chats-menu" ref={menu} style={menuStyle()} role="menu">
            <Show when={threads()} fallback={<div class="ws-closed-chats-empty">Loading…</div>}>
              {(list) => (
                <Show
                  when={list().length > 0}
                  fallback={<div class="ws-closed-chats-empty">No closed chats</div>}
                >
                  <For each={list()}>
                    {(thread) => (
                      <button
                        class="ws-closed-chat-item"
                        role="menuitem"
                        onClick={() => void restore(thread)}
                      >
                        <span class="ws-closed-chat-title">{thread.title}</span>
                        <span class="ws-closed-chat-meta">
                          {thread.provider}
                          <Show when={thread.archived_at}>
                            {(at) => <> · closed {relativeTime(at())}</>}
                          </Show>
                        </span>
                      </button>
                    )}
                  </For>
                </Show>
              )}
            </Show>
          </div>
        </Portal>
      </Show>
    </div>
  );
}
