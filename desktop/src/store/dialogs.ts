import { createSignal } from "solid-js";

// Lightweight global dialog host state. Only one dialog is open at a time; the
// <Dialogs/> host (mounted at the app root) renders the form for the active
// spec. Keeps modal state out of individual pages so any surface can trigger a
// create/lifecycle flow.

export type DialogSpec =
  | { kind: "add-project" }
  | { kind: "add-client" }
  | { kind: "create-workspace"; repository: string }
  | { kind: "workspace-actions"; workspace: string }
  | { kind: "background-task"; repository: string }
  // Reliable in-app confirm / prompt (window.confirm/prompt are unreliable in
  // Electron renderers). With `input` it collects a value; without, it's a plain
  // confirm. onConfirm runs the action; the caller surfaces any error.
  | {
      kind: "confirm";
      title: string;
      message: string;
      confirmLabel: string;
      destructive?: boolean;
      input?: { label: string; initialValue?: string };
      onConfirm: (value?: string) => void;
    };

export type ConfirmSpec = Extract<DialogSpec, { kind: "confirm" }>;

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
