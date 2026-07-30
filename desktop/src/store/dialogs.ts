import { createSignal } from "solid-js";

// Lightweight global dialog host state. Only one dialog is open at a time; the
// <Dialogs/> host (mounted at the app root) renders the form for the active
// spec. Keeps modal state out of individual pages so any surface can trigger a
// create/lifecycle flow.

export type DialogSpec =
  | { kind: "add-project" }
  | { kind: "create-workspace"; repository: string }
  | { kind: "workspace-actions"; workspace: string };

const [dialog, setDialog] = createSignal<DialogSpec | null>(null);

export const dialogs = {
  current: dialog,
  open(spec: DialogSpec) {
    setDialog(spec);
  },
  close() {
    setDialog(null);
  },
};
