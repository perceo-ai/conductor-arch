import { For, Match, Show, Switch, createEffect, createMemo, createSignal, on, onCleanup, onMount } from "solid-js";
import {
  chatStore,
  threadsStore,
  nav,
  loadThread,
  interactionsStore,
  prefsStore,
} from "@/store";
import { send } from "@/bridge/client";
import type {
  ArchcarChatThread,
  WorkspaceChangeScope,
} from "@/bridge/protocol";
import { titleCaseWorkspace } from "@/lib/text";
import { registerOpenFile, registerOpenCommit } from "./openFileBridge";
import Icon from "@/components/Icon";
import { ThreadTab, FileTab } from "./chat/ChatTabs";
import { Timeline } from "./chat/Timeline";
import { Composer } from "./chat/Composer";
import { FileView, CommitView } from "./chat/FileViews";
import { InteractionBanner, PlanCard } from "./chat/Interactions";
import { configuredShortcut } from "@/lib/configuredShortcut";

// Chat surface — center panel of the command center. Holds chat tabs + open-file
// tabs, and a content stack showing either the chat timeline or a file's diff,
// with the composer beneath. Chats are provider sessions (codex/claude) driven
// by archcar; the projected timeline is built in core (get_chat_projection), so
// the render_class -> component mapping lives in chat/TimelineItem.tsx.
//
// This file is the shell only. Tabs, timeline, composer, interactions and file
// viewers are each their own module under ./chat.

type CenterView =
  | { kind: "chat" }
  // The scope the file was opened under, so its diff matches the list it came
  // from rather than always showing everything since the review base.
  | { kind: "file"; path: string; scope: WorkspaceChangeScope }
  | { kind: "commit"; commit: string };

export default function ChatSurface(props: { workspace: string }) {
  // Only agent chats (codex/claude) belong in the tab strip. "shell" sessions
  // are the terminal dock, not chats — hide any legacy shell-provider threads.
  const threads = createMemo(() =>
    threadsStore.list(props.workspace).filter((t) => t.provider !== "shell"),
  );
  const [openFilePath, setOpenFilePath] = createSignal<string | null>(null);
  // Remembered so re-selecting the file's tab restores the scope it was opened
  // under instead of silently falling back to "all changes".
  const [openFileScope, setOpenFileScope] = createSignal<WorkspaceChangeScope>("all");
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
  onMount(() => registerOpenFile((ws, path, scope) => {
    if (ws !== props.workspace) return;
    openFile(path, scope);
  }));
  // Let the recent-commits list open a commit's diff into the center.
  onMount(() => registerOpenCommit((ws, commit) => {
    if (ws !== props.workspace) return;
    setView({ kind: "commit", commit });
  }));

  function openFile(path: string, scope: WorkspaceChangeScope = "all") {
    setOpenFilePath(path);
    setOpenFileScope(() => scope);
    setView({ kind: "file", path, scope });
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

  async function newChat(provider?: string, model?: string) {
    const chosen = provider ?? newProvider();
    setNewProvider(chosen);
    try {
      const res = await send({
        type: "create_chat_thread",
        workspace: props.workspace,
        provider: chosen,
        title: "New chat"
      });
      const list = await threadsStore.refresh(props.workspace);
      if (res.type === "chat_thread_created") {
        // Seed the new chat with the default model so it opens ready to run.
        const seed = model || prefsStore.seedModelFor(chosen);
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
                onClick={() => setView({ kind: "file", path: path(), scope: openFileScope() })}
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
        <button
          class="ui-button-icon ws-chat-new"
          title="New chat"
          data-shortcut={configuredShortcut("new-chat")}
          onClick={() => void newChat()}
        >
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
          <FileView
            workspace={props.workspace}
            path={(view() as { path: string }).path}
            scope={(view() as { scope: WorkspaceChangeScope }).scope}
          />
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
            currentModel={activeThread()!.model}
            currentEffortMode={activeThread()!.effort_mode}
            currentFastMode={activeThread()!.fast_mode}
            seedModel={pendingSeed()[activeThread()!.id]}
            onSeeded={() => clearSeed(activeThread()!.id)}
            onChangeAgentModel={(provider, model) => {
              if (provider !== activeThread()!.provider) void newChat(provider, model);
            }}
          />
        </Match>
      </Switch>
    </div>
  );
}
