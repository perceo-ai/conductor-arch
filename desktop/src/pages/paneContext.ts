import { createContext, useContext } from "solid-js";
import { nav } from "@/store";

// A pane is one workspace view on screen. With the workspace view split there
// are two, side by side, and each must show its own workspace's chat and only
// answer window-wide shortcuts (new chat, close chat, review…) when it is the
// focused one. Components ask the pane rather than the global nav, which only
// knows about the focused workspace.

export interface Pane {
  /** True for the pane the sidebar and keyboard shortcuts act on. */
  focused: () => boolean;
  /** The chat thread this pane's workspace shows. */
  threadId: () => number | null;
  selectThread: (threadId: number | null) => void;
}

const PaneContext = createContext<Pane>();

export const PaneProvider = PaneContext.Provider;

/**
 * Pane for a workspace view, from an enclosing `PaneProvider`. Outside one
 * (tests, or any surface rendered on its own) the view is the only one on
 * screen, so it reads and writes the global selection.
 */
export function usePane(): Pane {
  return (
    useContext(PaneContext) ?? {
      focused: () => true,
      threadId: () => nav.selectedChatThread(),
      selectThread: (threadId) => nav.selectChatThread(threadId),
    }
  );
}

/** The pane bound to `workspace()`, focused while `focused()` holds. */
export function paneFor(workspace: () => string, focused: () => boolean): Pane {
  return {
    focused,
    threadId: () => nav.threadFor(workspace()),
    selectThread: (threadId) => nav.selectThreadFor(workspace(), threadId),
  };
}
