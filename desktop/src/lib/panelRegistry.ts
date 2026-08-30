import { lazy, type Component } from "solid-js";
import type { IconName } from "@/components/Icon";
import type { PanelId } from "./layout";

/**
 * How a panel presents its chrome. `layout.ts`'s `displayFor` reads this to seed
 * a newly split-out leaf's `display`: a `strip` or `dock` lands `compact` (no
 * one-tab strip above chrome that is already a bar), a `tab` lands `tabs`.
 */
export type PanelKind = "tab" | "strip" | "dock";

export interface PanelProps {
  workspace: string;
}

export interface PanelDescriptor {
  id: PanelId;
  title: string;
  icon: IconName;
  kind: PanelKind;
  component: Component<PanelProps>;
  // No per-panel minimums here: `panelWidths.ts`'s PANEL_MIN_PX /
  // PANEL_MIN_HEIGHT_PX tables are the single place a panel's minimum is
  // expressed, and the only place `LayoutNodeView` reads one from.
  requiresWorkspace: boolean;
}

const panels = new Map<PanelId, PanelDescriptor>();

export function registerPanel(descriptor: PanelDescriptor) {
  panels.set(descriptor.id, descriptor);
}

export function unregisterPanel(id: PanelId) {
  panels.delete(id);
}

export function panelDescriptor(id: PanelId): PanelDescriptor | undefined {
  return panels.get(id);
}

export function registeredPanels(): PanelDescriptor[] {
  return [...panels.values()];
}

export function workspacePanels(): PanelDescriptor[] {
  return registeredPanels().filter((panel) => panel.requiresWorkspace);
}

const ChatSurface = lazy(() => import("@/pages/ChatSurface")) as Component<PanelProps>;
const WorkspacePrBar = lazy(() => import("@/pages/WorkspacePrBar")) as Component<PanelProps>;
const WorkspaceFiles = lazy(() => import("@/pages/WorkspaceFiles")) as Component<PanelProps>;
const WorkspaceChanges = lazy(() => import("@/pages/WorkspaceChanges")) as Component<PanelProps>;
const TerminalDock = lazy(() => import("@/pages/TerminalDock")) as Component<PanelProps>;
const SummaryPanel = lazy(async () => ({ default: (await import("@/pages/WorkspaceIntel")).SummaryPanel })) as Component<PanelProps>;
const ContextPanel = lazy(async () => ({ default: (await import("@/pages/WorkspaceIntel")).ContextPanel })) as Component<PanelProps>;
const TodosPanel = lazy(async () => ({ default: (await import("@/pages/WorkspaceTabs")).TodosPanel })) as Component<PanelProps>;
const CheckpointsPanel = lazy(async () => ({ default: (await import("@/pages/WorkspaceTabs")).CheckpointsPanel })) as Component<PanelProps>;
const ProcessesPanel = lazy(async () => ({ default: (await import("@/pages/WorkspaceTabs")).ProcessesPanel })) as Component<PanelProps>;
const TimelinePanel = lazy(async () => ({ default: (await import("@/pages/WorkspaceTabs")).TimelinePanel })) as Component<PanelProps>;
const ChecksPanel = lazy(async () => ({ default: (await import("@/pages/WorkspaceTabs")).ChecksPanel })) as Component<PanelProps>;

const builtins: PanelDescriptor[] = [
  { id: "chat", title: "Chat", icon: "send", kind: "tab", component: ChatSurface, requiresWorkspace: true },
  { id: "pr", title: "Pull request", icon: "git-pull-request", kind: "strip", component: WorkspacePrBar, requiresWorkspace: true },
  { id: "summary", title: "Summary", icon: "file-text", kind: "tab", component: SummaryPanel, requiresWorkspace: true },
  { id: "files", title: "Files", icon: "folder", kind: "tab", component: WorkspaceFiles, requiresWorkspace: true },
  { id: "changes", title: "Changes", icon: "git-compare", kind: "tab", component: WorkspaceChanges, requiresWorkspace: true },
  { id: "checks", title: "Checks", icon: "circle-check", kind: "tab", component: ChecksPanel, requiresWorkspace: true },
  { id: "terminal", title: "Terminal", icon: "terminal", kind: "dock", component: TerminalDock, requiresWorkspace: true },
  { id: "todos", title: "Todos", icon: "circle-check", kind: "tab", component: TodosPanel, requiresWorkspace: true },
  { id: "checkpoints", title: "Checkpoints", icon: "history", kind: "tab", component: CheckpointsPanel, requiresWorkspace: true },
  { id: "processes", title: "Processes", icon: "monitor", kind: "tab", component: ProcessesPanel, requiresWorkspace: true },
  { id: "timeline", title: "Timeline", icon: "history", kind: "tab", component: TimelinePanel, requiresWorkspace: true },
  { id: "context", title: "Context", icon: "paperclip", kind: "tab", component: ContextPanel, requiresWorkspace: true },
];

builtins.forEach(registerPanel);
