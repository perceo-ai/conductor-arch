import { For, Show, createEffect, createMemo, on, onMount } from "solid-js";
import {
  chatStore,
  interactionsStore,
} from "@/store";
import { timelineItemsForSlice } from "@/store/chat";
import type {
  ArchcarProjectionItem,
} from "@/bridge/protocol";
import { isDisplayableTimelineItem } from "@/lib/timeline";
import { isNearScrollBottom, scrollBottomTop } from "@/lib/chatScroll";
import DotGridLoader from "@/components/DotGridLoader";
import {
  chatGenerationState,
  generationLabel,
  showsGenerationLoader,
  type ChatGenerationState
} from "@/lib/chatGeneration";
import { NewChatIntro } from "./NewChatIntro";
import { TimelineItem } from "./TimelineItem";

// The scrolling message column, including follow-the-bottom behaviour and the
// generation loader that trails the last message.
export function Timeline(props: { threadId: number; workspace: string }) {
  let scrollRef: HTMLDivElement | undefined;
  let followBottom = true;
  const slice = () => chatStore.slice(props.threadId);
  const items = createMemo<ArchcarProjectionItem[]>(() =>
    timelineItemsForSlice(slice()).filter(isDisplayableTimelineItem),
  );
  // The loader sits inside the scrolled content, so its appearance and
  // disappearance change the content height — it belongs in the scroll signal
  // or the view stops following the bottom the moment generation starts.
  const generation = createMemo<ChatGenerationState>(() =>
    chatGenerationState({
      session: slice().session,
      phase: slice().phase,
      blockedOnUser: interactionsStore.pending(props.threadId) != null
    }),
  );
  const scrollSignal = createMemo(
    () =>
      `${generation()}|` +
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
        {/* Last child of the message column, so it always trails the newest
            message rather than floating in fixed chrome. Inside the scroller,
            so the existing follow-bottom behaviour keeps it in view. */}
        <Show when={showsGenerationLoader(generation())}>
          <DotGridLoader class="chat-generation-loader" label={generationLabel(generation())} />
        </Show>
      </div>
    </div>
  );
}

