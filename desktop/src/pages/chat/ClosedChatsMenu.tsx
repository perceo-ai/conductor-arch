import { For, Match, Show, Switch, createEffect, createSignal, on, onCleanup } from "solid-js";
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
 *
 * The component outlives a workspace switch (ChatSurface only swaps its
 * `workspace` prop), so every reply is checked against a generation: a list or
 * restore for workspace A that lands after the switch to B is dropped instead
 * of showing A's chats under B. Lists and restores use separate counters,
 * because reopening the menu re-lists, and that must not orphan a restore
 * still in flight for the same workspace.
 *
 * The daemon reports a failed request as a resolved `{ type: "error" }`
 * reply, not a rejection, so both paths check the reply type as well.
 */
type ListState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "loaded"; threads: ArchcarChatThread[] };

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function ClosedChatsMenu(props: {
  workspace: string;
  onRestored: (threadId: number) => void;
}) {
  const [open, setOpen] = createSignal(false);
  const [list, setList] = createSignal<ListState>({ status: "idle" });
  const [restoreError, setRestoreError] = createSignal<string | null>(null);
  const [anchor, setAnchor] = createSignal<DOMRect | null>(null);
  let trigger: HTMLButtonElement | undefined;
  let menu: HTMLDivElement | undefined;
  // Bumped on every list request and every workspace switch; a list reply
  // whose generation is no longer current belongs to a request nobody wants.
  let generation = 0;
  // Bumped only on a workspace switch. A restore outlives closing and
  // reopening the menu (which re-lists), but not leaving its workspace.
  let workspaceGeneration = 0;

  createEffect(
    on(
      () => props.workspace,
      () => {
        generation += 1;
        workspaceGeneration += 1;
        setOpen(false);
        setList({ status: "idle" });
        setRestoreError(null);
      },
      { defer: true },
    ),
  );

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

  const failed = () => {
    const state = list();
    return state.status === "error" ? state : undefined;
  };
  const loaded = () => {
    const state = list();
    return state.status === "loaded" ? state : undefined;
  };

  async function load() {
    const requested = ++generation;
    setList({ status: "loading" });
    setRestoreError(null);
    try {
      const res = await send({
        type: "list_closed_chat_threads",
        workspace: props.workspace,
      });
      if (requested !== generation) return;
      if (res.type === "chat_threads") {
        setList({ status: "loaded", threads: res.threads });
      } else {
        setList({
          status: "error",
          message: res.type === "error" ? res.message : `unexpected reply: ${res.type}`,
        });
      }
    } catch (err) {
      if (requested !== generation) return;
      setList({ status: "error", message: errorMessage(err) });
    }
  }

  function toggle() {
    if (open()) {
      setOpen(false);
      return;
    }
    if (trigger) setAnchor(trigger.getBoundingClientRect());
    setOpen(true);
    void load();
  }

  async function restore(thread: ArchcarChatThread) {
    const requested = workspaceGeneration;
    setRestoreError(null);
    let failure: string | null = null;
    try {
      const res = await send({ type: "reopen_chat_thread", thread_id: thread.id });
      if (res.type === "error") failure = res.message || "the daemon refused";
    } catch (err) {
      failure = errorMessage(err);
    }
    // Reopened (or refused) in the workspace that listed it; if the user has
    // since switched away, the parent would search the wrong workspace, and a
    // reopened chat is simply back in its own tab strip when they return.
    if (requested !== workspaceGeneration) return;
    if (failure !== null) {
      setRestoreError(`Could not restore "${thread.title}": ${failure}`);
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
        onClick={toggle}
      >
        <Icon name="history" />
      </button>
      <Show when={open()}>
        {/* Portalled for the same reason as the model picker: the tab bar's
            scroller would clip a menu rendered in place. */}
        <Portal>
          <div class="ws-closed-chats-menu" ref={menu} style={menuStyle()} role="menu">
            <Show when={restoreError()}>
              {(message) => (
                <div class="ws-closed-chats-error" role="alert">
                  {message()}
                </div>
              )}
            </Show>
            <Switch fallback={<div class="ws-closed-chats-empty">Loading…</div>}>
              <Match when={failed()}>
                {(failed) => (
                  <div class="ws-closed-chats-error" role="alert">
                    <span>Could not load closed chats: {failed().message}</span>
                    <button class="ws-closed-chats-retry" onClick={() => void load()}>
                      Retry
                    </button>
                  </div>
                )}
              </Match>
              <Match when={loaded()}>
                {(loaded) => (
                  <Show
                    when={loaded().threads.length > 0}
                    fallback={<div class="ws-closed-chats-empty">No closed chats</div>}
                  >
                    <For each={loaded().threads}>
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
              </Match>
            </Switch>
          </div>
        </Portal>
      </Show>
    </div>
  );
}
