import { lazy, type Component } from "solid-js";
import type { IconName } from "@/components/Icon";
import type { PanelId, PanelKind, Region } from "./layout";

export interface PanelProps {
  workspace: string;
  region: Region;
}

export interface PanelDescriptor {
  id: PanelId;
  title: string;
  icon: IconName;
  kind: PanelKind;
  component: Component<PanelProps>;
  regions: Region[];
  defaultRegion: Region;
  minWidth?: number;
  minHeight?: number;
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

const allRegions: Region[] = ["left", "center", "bottom", "right"];

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
  { id: "chat", title: "Chat", icon: "send", kind: "tab", component: ChatSurface, regions: allRegions, defaultRegion: "center", requiresWorkspace: true },
  { id: "pr", title: "Pull request", icon: "git-pull-request", kind: "strip", component: WorkspacePrBar, regions: allRegions, defaultRegion: "right", requiresWorkspace: true },
  { id: "summary", title: "Summary", icon: "file-text", kind: "tab", component: SummaryPanel, regions: allRegions, defaultRegion: "right", requiresWorkspace: true },
  { id: "files", title: "Files", icon: "folder", kind: "tab", component: WorkspaceFiles, regions: allRegions, defaultRegion: "right", requiresWorkspace: true },
  { id: "changes", title: "Changes", icon: "git-compare", kind: "tab", component: WorkspaceChanges, regions: allRegions, defaultRegion: "right", requiresWorkspace: true },
  { id: "checks", title: "Checks", icon: "circle-check", kind: "tab", component: ChecksPanel, regions: allRegions, defaultRegion: "right", requiresWorkspace: true },
  { id: "terminal", title: "Terminal", icon: "terminal", kind: "dock", component: TerminalDock, regions: allRegions, defaultRegion: "right", requiresWorkspace: true },
  { id: "todos", title: "Todos", icon: "circle-check", kind: "tab", component: TodosPanel, regions: allRegions, defaultRegion: "right", requiresWorkspace: true },
  { id: "checkpoints", title: "Checkpoints", icon: "history", kind: "tab", component: CheckpointsPanel, regions: allRegions, defaultRegion: "right", requiresWorkspace: true },
  { id: "processes", title: "Processes", icon: "monitor", kind: "tab", component: ProcessesPanel, regions: allRegions, defaultRegion: "right", requiresWorkspace: true },
  { id: "timeline", title: "Timeline", icon: "history", kind: "tab", component: TimelinePanel, regions: allRegions, defaultRegion: "right", requiresWorkspace: true },
  { id: "context", title: "Context", icon: "paperclip", kind: "tab", component: ContextPanel, regions: allRegions, defaultRegion: "right", requiresWorkspace: true },
];

builtins.forEach(registerPanel);
