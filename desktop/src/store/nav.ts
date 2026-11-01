import { createSignal } from "solid-js";
import {
  activeWorkspace,
  closeTab,
  emptyTabs,
  focusGroup,
  groupIndexOf,
  moveTab,
  openTab,
  renameTab,
  retainTabs,
  splitTab,
  type SplitDirection,
  type WorkspaceTabsState,
} from "@/lib/workspaceTabs";
import { loadTabRealm, materializeTabs, saveTabRealm, serializeTabs } from "@/lib/tabPersistence";

// Navigation state — mirrors the navigation fields of
// crates/gtk-app/src/state.rs::AppStateSnapshot. Each field is its own signal so
// reading `activePage` does not couple a component to `selectedChatThread`, etc.
// This is the fine-grained equivalent of the AppStateEvent selection events.

export type AppPage = "dashboard" | "workspace" | "history" | "settings" | "review";

const [selectedWorkspace, setSelectedWorkspaceRaw] = createSignal<string | null>(null);
const [activePage, setActivePage] = createSignal<AppPage>("dashboard");
const [selectedChatThread, setSelectedChatThread] = createSignal<number | null>(null);
const [windowFocused, setWindowFocused] = createSignal(true);
// False while the chat surface shows a file or commit over the selected chat:
// the chat tab stays selected underneath, but it is not what is on screen.
const [chatSurfaceShowsChat, setChatSurfaceShowsChat] = createSignal(true);
// Open workspace tabs. The focused group's active tab is `selectedWorkspace`;
// every other tab remembers the chat it was on so coming back lands there.
const [workspaceTabs, setWorkspaceTabs] = createSignal<WorkspaceTabsState>(emptyTabs());
const [threadByWorkspace, setThreadByWorkspace] = createSignal<Record<string, number>>({});
// Which daemon's tabs these are. Saved continuously under this key, so a
// daemon switch or an app quit never has a "flush on exit" step to miss.
let tabRealm = "local";

function persistTabs() {
  saveTabRealm(tabRealm, serializeTabs(workspaceTabs(), threadByWorkspace()));
}

interface NavEntry {
  selectedWorkspace: string | null;
  activePage: AppPage;
}

const [canBack, setCanBack] = createSignal(false);
const [canForward, setCanForward] = createSignal(false);
const back: NavEntry[] = [];
const forward: NavEntry[] = [];

function snapshot(): NavEntry {
  return {
    selectedWorkspace: selectedWorkspace(),
    activePage: activePage(),
  };
}

function pushHistory() {
  back.push(snapshot());
  forward.length = 0;
  setCanBack(true);
  setCanForward(false);
}

function rememberedThread(name: string | null): number | null {
  return name == null ? null : (threadByWorkspace()[name] ?? null);
}

/** Point the selection at `name`, restoring the chat that workspace was last on. */
function selectRaw(name: string | null) {
  if (name === selectedWorkspace()) return;
  setSelectedChatThread(rememberedThread(name));
  setSelectedWorkspaceRaw(name);
}

/**
 * Commit a new tab state and follow its focused tab. When the last tab closes
 * on the workspace page there is nothing left to show, so the dashboard takes
 * over rather than an empty "select a workspace" screen.
 */
function commitTabs(next: WorkspaceTabsState) {
  setWorkspaceTabs(next);
  persistTabs();
  const name = activeWorkspace(next);
  selectRaw(name);
  if (name == null && (activePage() === "workspace" || activePage() === "review")) {
    setActivePage("dashboard");
  }
}

function apply(entry: NavEntry) {
  if (entry.selectedWorkspace != null) {
    setWorkspaceTabs(openTab(workspaceTabs(), entry.selectedWorkspace));
    persistTabs();
  }
  selectRaw(entry.selectedWorkspace);
  setActivePage(entry.activePage);
}

export const nav = {
  selectedWorkspace,
  activePage,
  selectedChatThread,
  windowFocused,
  chatSurfaceShowsChat,
  canBack,
  canForward,
  workspaceTabs,

  setWindowFocused,
  setChatSurfaceShowsChat,
  /** Select a workspace and switch to its page (clears per-workspace selections). */
  /**
   * Select a workspace and switch to its page. The workspace opens as a tab, or
   * its existing tab (in either pane) takes focus.
   */
  selectWorkspace(name: string | null) {
    if (selectedWorkspace() === name && activePage() === "workspace") return;
    pushHistory();
    if (name != null) {
      setWorkspaceTabs(openTab(workspaceTabs(), name));
      persistTabs();
    }
    selectRaw(name);
    setActivePage("workspace");
  },

  goToPage(page: AppPage) {
    if (activePage() === page) return;
    pushHistory();
    setActivePage(page);
  },

  goToDashboard() {
    if (activePage() === "dashboard" && selectedWorkspace() == null) return;
    pushHistory();
    selectRaw(null);
    setActivePage("dashboard");
  },

  selectChatThread(threadId: number | null) {
    setSelectedChatThread(threadId);
    const name = selectedWorkspace();
    if (name != null) nav.rememberThread(name, threadId);
  },

  /** The chat a workspace's pane shows: the live selection if focused, else its memory. */
  threadFor(name: string): number | null {
    return name === selectedWorkspace() ? selectedChatThread() : rememberedThread(name);
  },

  /** Select a chat inside `name`'s pane without moving focus to that pane. */
  selectThreadFor(name: string, threadId: number | null) {
    if (name === selectedWorkspace()) nav.selectChatThread(threadId);
    else nav.rememberThread(name, threadId);
  },

  rememberThread(name: string, threadId: number | null) {
    const current = threadByWorkspace();
    if (threadId == null) {
      if (!(name in current)) return;
      const { [name]: _drop, ...rest } = current;
      setThreadByWorkspace(rest);
    } else if (current[name] !== threadId) {
      setThreadByWorkspace({ ...current, [name]: threadId });
    } else {
      return;
    }
    persistTabs();
  },

  /**
   * True when a chat is on screen in some pane: the focused one (unless a file
   * covers it) or the other pane's active workspace.
   */
  chatThreadInView(threadId: number): boolean {
    if (selectedChatThread() === threadId) return chatSurfaceShowsChat();
    const tabs = workspaceTabs();
    return tabs.groups.some(
      (group, i) => i !== tabs.focused && group.active != null && rememberedThread(group.active) === threadId,
    );
  },

  /** Focus a pane: its active tab becomes the selected workspace. */
  focusTabGroup(index: number) {
    const next = focusGroup(workspaceTabs(), index);
    if (next !== workspaceTabs()) commitTabs(next);
  },

  closeWorkspaceTab(name: string) {
    commitTabs(closeTab(workspaceTabs(), name));
  },

  /** Close every tab in `name`'s pane except `name`. */
  closeOtherWorkspaceTabs(name: string) {
    const group = workspaceTabs().groups.find((candidate) => candidate.tabs.includes(name));
    if (!group) return;
    let next = workspaceTabs();
    for (const tab of group.tabs) if (tab !== name) next = closeTab(next, tab);
    commitTabs(openTab(next, name));
  },

  splitWorkspaceTab(name: string, direction: SplitDirection) {
    commitTabs(splitTab(workspaceTabs(), name, direction));
  },

  /**
   * Open `name` beside what is on screen: into a new split, or into the other
   * pane when the view is already split. With nothing else open there is no
   * second pane to make, so it simply opens.
   */
  openWorkspaceInSplit(name: string, direction: SplitDirection) {
    pushHistory();
    const tabs = workspaceTabs();
    const at = groupIndexOf(tabs, name);
    let next = openTab(tabs, name);
    // Already beside the focused pane: focusing it is the whole job.
    const alreadyBeside = tabs.groups.length > 1 && at >= 0 && at !== tabs.focused;
    if (!alreadyBeside) next = splitTab(next, name, direction);
    commitTabs(next);
    setActivePage("workspace");
  },

  moveWorkspaceTab(name: string, group: number, index: number) {
    commitTabs(moveTab(workspaceTabs(), name, group, index));
  },

  /** Follow a server-side rename: the tab, its chat memory, and the selection. */
  renameWorkspace(from: string, to: string) {
    const memory = threadByWorkspace();
    if (from in memory) {
      const { [from]: thread, ...rest } = memory;
      setThreadByWorkspace({ ...rest, [to]: thread });
    }
    setWorkspaceTabs(renameTab(workspaceTabs(), from, to));
    persistTabs();
    if (selectedWorkspace() === from) setSelectedWorkspaceRaw(to);
  },

  resetWorkspaceTabs() {
    setThreadByWorkspace({});
    commitTabs(emptyTabs());
  },

  /**
   * Swap to `realm`'s saved tabs (boot, or a daemon switch). The old realm's
   * state is already on disk — every mutation persists — so this only loads.
   * Stored names are checked against `keep` (the live inventory); whatever
   * survives is committed, and landing on a restored tab switches to the
   * workspace page so the app opens where it was closed.
   */
  restoreWorkspaceTabs(realm: string, keep: (name: string) => boolean) {
    tabRealm = realm;
    const { state, threads } = materializeTabs(loadTabRealm(realm), keep);
    setThreadByWorkspace(threads);
    commitTabs(state);
    if (activeWorkspace(state) != null) setActivePage("workspace");
  },

  /** Drop tabs for workspaces that were archived, deleted, or are not on this daemon. */
  retainWorkspaceTabs(keep: (name: string) => boolean) {
    const next = retainTabs(workspaceTabs(), keep);
    if (next !== workspaceTabs()) commitTabs(next);
  },

  back() {
    const entry = back.pop();
    if (!entry) return;
    forward.push(snapshot());
    apply(entry);
    setCanBack(back.length > 0);
    setCanForward(true);
  },

  forward() {
    const entry = forward.pop();
    if (!entry) return;
    back.push(snapshot());
    apply(entry);
    setCanForward(forward.length > 0);
    setCanBack(true);
  },
};
