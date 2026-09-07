import Icon from "@/components/Icon";
import {
  openContextMenu,
  openContextMenuFromKeyboard,
  type ContextMenuItem,
} from "@/components/ContextMenu";
import { actions } from "@/store";
import { toastsStore } from "@/store/toasts";

// One persistent action after a completed turn forks the conversation into a
// second tab in the same workspace or into a workspace of its own.
//
// The fork point is the turn-ending message's `timeline_seq`; Timeline only
// renders this control when that position exists.

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

export function TurnForkAction(props: { threadId: number; timelineSeq: number }) {
  return (
    <button
      class="chat-turn-fork"
      aria-label="Fork turn"
      title="Fork turn"
      onClick={(e) => openContextMenu(e, forkMenuItems(props))}
      onKeyDown={(e) => {
        if (e.key !== "Enter" && e.key !== " ") return;
        openContextMenuFromKeyboard(e, forkMenuItems(props));
      }}
    >
      <Icon name="git-branch" />
      <span>Fork</span>
      <Icon name="chevron-down" />
    </button>
  );
}
