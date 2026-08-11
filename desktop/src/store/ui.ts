import { createSignal } from "solid-js";

// Small shared UI-overlay state so surfaces other than App (e.g. the command
// palette) can open the keyboard-shortcuts help. Kept tiny and dependency-free.

const [helpOpen, setHelpOpen] = createSignal(false);

export const uiStore = {
  helpOpen,
  setHelpOpen,
  toggleHelp: () => setHelpOpen((o) => !o),
};
