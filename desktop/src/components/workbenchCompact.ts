import { createContext, useContext } from "solid-js";

// With the workspace view split, the unfocused pane is a plain chat column:
// the inspector, terminal, and every other panel follow the focused pane so
// two full workbenches never fight for the same width.
//
// That used to be done by handing the workbench a *different* tree — the chat
// leaf on its own. Swapping the tree's shape on every focus change remounted
// everything inside it, chat included, so each switch between panes rebuilt
// the transcript and scrolled it to the bottom from the top again. So compact
// is a flag carried down the real tree instead: the splits stay, the chat leaf
// keeps its DOM, and the subtree without chat in it is the only thing that
// comes and goes.

export interface WorkbenchCompact {
  /** True while this workbench shows its chat column alone. */
  active: () => boolean;
  /** The leaf holding chat — the only leaf a compact workbench renders. */
  chatLeafId: () => string | null;
}

const FULL: WorkbenchCompact = { active: () => false, chatLeafId: () => null };

const WorkbenchCompactContext = createContext<WorkbenchCompact>();

export const WorkbenchCompactProvider = WorkbenchCompactContext.Provider;

/** Compact state for the enclosing workbench; full view outside one. */
export function useWorkbenchCompact(): WorkbenchCompact {
  return useContext(WorkbenchCompactContext) ?? FULL;
}
