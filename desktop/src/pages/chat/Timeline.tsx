import { For, Show, createEffect, createMemo, createSignal, on, onMount } from "solid-js";
import {
  chatStore,
  interactionsStore,
} from "@/store";
import { timelineItemsForSlice } from "@/store/chat";
import type {
  ArchcarProjectionItem,
} from "@/bridge/protocol";
import {
  TIMELINE_WINDOW_SIZE,
  TIMELINE_WINDOW_STEP,
  forkableTurnEndIds,
  isDisplayableTimelineItem,
  showsNewChatIntro,
  timelineWindow,
  withoutPlanSource,
} from "@/lib/timeline";
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
import { PlanCard } from "./Interactions";

// The scrolling message column, including follow-the-bottom behaviour and the
// generation loader that trails the last message.
export function Timeline(props: { threadId: number; workspace: string }) {
  let scrollRef: HTMLDivElement | undefined;
  let followBottom = true;
  const slice = () => chatStore.slice(props.threadId);
  const pendingPlan = () => {
    const pending = interactionsStore.pending(props.threadId);
    return pending?.kind === "plan_approval" ? pending : null;
  };
  const items = createMemo<ArchcarProjectionItem[]>(() =>
    // The plan card renders the plan, so the assistant message it was lifted
    // from must not render it a second time.
    withoutPlanSource(
      timelineItemsForSlice(slice()).filter(isDisplayableTimelineItem),
      pendingPlan()?.detail,
    ),
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
  const forkableItems = createMemo(() => forkableTurnEndIds(items(), generation() === "idle"));
  // Only the newest rows are mounted; scrolling back extends the window rather
  // than paying for the whole history up front. Turn boundaries are still
  // computed over every item, so which rows are forkable does not change.
  const [visibleCount, setVisibleCount] = createSignal(TIMELINE_WINDOW_SIZE);
  const windowed = createMemo(() => timelineWindow(items(), visibleCount()));
  // A different chat starts at the bottom of its own history.
  createEffect(on(() => props.threadId, () => setVisibleCount(TIMELINE_WINDOW_SIZE), { defer: true }));

  function revealOlder() {
    const el = scrollRef;
    // Anchor on distance from the bottom: prepending rows grows scrollHeight,
    // and keeping scrollTop would slide the reader up into the new content.
    const anchor = el ? el.scrollHeight - el.scrollTop : null;
    setVisibleCount((count) => count + TIMELINE_WINDOW_STEP);
    if (el && anchor != null) {
      requestAnimationFrame(() => {
        el.scrollTop = el.scrollHeight - anchor;
      });
    }
  }
  // The plan card is part of the scrolled content, so its arrival has to move
  // the view the same way a new message does.
  const scrollSignal = createMemo(
    () =>
      `${generation()}|${pendingPlan()?.id ?? ""}|` +
      windowed()
        .visible.map((item) => `${item.id}:${item.status}:${item.stream_state}:${item.body.length}`)
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
          when={!showsNewChatIntro(items().length, pendingPlan() != null)}
          fallback={<NewChatIntro workspace={props.workspace} threadId={props.threadId} />}
        >
          <Show when={windowed().hidden > 0}>
            <button class="chat-timeline-reveal-older" onClick={revealOlder}>
              Show earlier messages ({windowed().hidden})
            </button>
          </Show>
          <For each={windowed().visible}>
            {(item) => (
              <TimelineItem
                item={item}
                agentIdle={agentIdle()}
                threadId={props.threadId}
                forkable={forkableItems().has(item.id)}
              />
            )}
          </For>
        </Show>
        {/* A proposed plan is a message in the conversation, not chrome bolted
            above the composer: it belongs in the scrollback where it can be
            read back later, and it carries its own actions. */}
        <Show when={pendingPlan()}>
          {(rec) => <PlanCard rec={rec()} workspace={props.workspace} />}
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
