import { Show } from "solid-js";
import Icon from "@/components/Icon";
import {
  openContextMenu,
  openContextMenuFromKeyboard,
  type ContextMenuItem,
} from "@/components/ContextMenu";
import { actions } from "@/store";
import { toastsStore } from "@/store/toasts";
import type { ArchcarProjectionItem } from "@/bridge/protocol";

// The per-message overflow menu: fork this conversation from here, either into
// a second tab in the same workspace or into a workspace of its own.
//
// The fork point is the item's `timeline_seq`. An item without one cannot say
// where it sits in the conversation, so it gets no menu rather than a menu that
// would silently fork the whole thing.

export function forkMenuItems(props: {
  threadId: number;
  timelineSeq: number;
}): ContextMenuItem[] {
  return [
    {
      label: "Fork to new tab",
      icon: "plus",
      run: () => {
        void runFork({ ...props, newWorkspace: false });
      },
    },
    {
      label: "Fork to new workspace",
      icon: "git-branch",
      run: () => {
        void runFork({ ...props, newWorkspace: true });
      },
    },
  ];
}

async function runFork(input: {
  threadId: number;
  timelineSeq: number;
  newWorkspace: boolean;
}): Promise<void> {
  try {
    const forked = await actions.forkChat({
      threadId: input.threadId,
      throughTimelineSeq: input.timelineSeq,
      newWorkspace: input.newWorkspace,
    });
    toastsStore.push(
      input.newWorkspace
        ? `Forked into workspace ${forked.workspace}`
        : "Forked to a new chat",
    );
  } catch (err) {
    // Creating a workspace can fail on a branch that already exists, and the
    // fork is the kind of action where silence reads as "nothing happened".
    toastsStore.error(`Fork failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export function MessageActions(props: { item: ArchcarProjectionItem; threadId: number }) {
  const seq = () => props.item.timeline_seq;
  return (
    <Show when={seq() != null}>
      <button
        class="chat-message-actions"
        aria-label="Message actions"
        title="Message actions"
        onClick={(e) => openContextMenu(e, forkMenuItems({ threadId: props.threadId, timelineSeq: seq()! }))}
        onKeyDown={(e) => {
          if (e.key !== "Enter" && e.key !== " ") return;
          openContextMenuFromKeyboard(e, forkMenuItems({ threadId: props.threadId, timelineSeq: seq()! }));
        }}
      >
        <Icon name="ellipsis" />
      </button>
    </Show>
  );
}
