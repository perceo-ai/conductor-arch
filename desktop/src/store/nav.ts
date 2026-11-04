import { batch, createSignal, untrack } from "solid-js";
import {
  activeWorkspace,
  closePane,
  closeWorkspace,
  emptyPanes,
  focusPane,
  openWorkspace,
  openWorkspaceIn,
  renameWorkspace as renamePaneWorkspace,
  retainWorkspaces,
  splitWorkspace,
  type SplitDirection,
  type WorkspacePanesState,
} from "@/lib/workspacePanes";
import { loadPaneRealm, materializePanes, savePaneRealm, serializePanes } from "@/lib/panePersistence";
import { composerDrafts } from "@/lib/composerDrafts";
import { editorDraftStash } from "@/lib/editorDraftStash";

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
// The split view's panes. The focused pane's workspace is `selectedWorkspace`;
// the other remembers the chat it was on so coming back lands there.
const [workspacePanes, setWorkspacePanes] = createSignal<WorkspacePanesState>(emptyPanes());
const [threadByWorkspace, setThreadByWorkspace] = createSignal<Record<string, number>>({});
/**
 * The realm before any daemon identity is known. Deliberately a different
 * string from every real tabRealmKey() value ("local", "client:<id>",
 * "env:<address>"): "no realm assigned yet" and "this machine" must never
 * share a storage or draft-stash key, or state from the unassigned window
 * leaks into the local daemon's (and vice versa) the moment they meet.
 */
export const UNASSIGNED_REALM = "__unassigned__";

// Which daemon's tabs these are. Saved continuously under this key, so a
// daemon switch or an app quit never has a "flush on exit" step to miss. A
// signal so views that cache it (the file editor) can be remounted when it
// changes; persistence reads it untracked.
const [tabRealm, setTabRealmRaw] = createSignal(UNASSIGNED_REALM);

/**
 * The daemon the views on screen belong to. A real daemon switch replaces the
 * object, so views keyed on it (the file editor) remount and anything holding
 * the old object keeps the old realm for its cleanup. Startup learning the
 * daemon's identity for the first time is not a switch — same daemon, the
 * realm was just the unassigned placeholder — so it corrects `realm` in place
 * and nothing remounts or loses unsaved state.
 */
export interface TabRealmSession {
  realm: string;
}
const [tabRealmSession, setTabRealmSession] = createSignal<TabRealmSession>({
  realm: UNASSIGNED_REALM,
});
// False until a restore or startup first assigns the active daemon's realm.
let realmKnown = false;
// True while an explicit daemon switch (clientsStore) is in flight. A switch is
// declared, never inferred: it can be the run's first realm assignment too
// (startup failed before learning the realm), and treating that as a
// correction would keep the old daemon's editor in front of the new one.
let daemonSwitchPending = false;

function assignTabRealm(realm: string) {
  const prev = untrack(tabRealm);
  // A declared switch always replaces the session, with no realm-string
  // comparison: switching daemons must remount the views keyed on it, or the
  // old daemon's text saves to the new daemon's file. (The distinct
  // UNASSIGNED_REALM makes the strings differ too, but the declaration is
  // what makes it a switch.) Without a declaration, a changed realm after the
  // realm was known is still treated as a switch (defensive — every
  // clientsStore switch declares); only the remaining case, correcting the
  // placeholder to the daemon's real identity, edits in place so startup
  // never remounts over unsaved state.
  if (daemonSwitchPending || (realmKnown && realm !== prev)) {
    setTabRealmSession({ realm });
  } else {
    untrack(tabRealmSession).realm = realm;
    // The one moment the daemon behind the placeholder gets its real name:
    // everything parked under the sentinel belongs to it, whether or not the
    // component that parked it is still mounted. A declared switch never
    // migrates — the other branch — so another daemon's sentinel-era drafts
    // cannot leak across. Runs once: `prev` is never the sentinel again.
    if (prev === UNASSIGNED_REALM && realm !== UNASSIGNED_REALM) {
      composerDrafts.migrateRealm(prev, realm);
      editorDraftStash.migrateRealm(prev, realm);
    }
  }
  realmKnown = true;
  daemonSwitchPending = false;
  setTabRealmRaw(realm);
}
// True from "a restore is owed" (boot before the inventory arrived, or a
// daemon switch in flight) until restoreWorkspaceTabs runs. While it holds,
// nothing persists: the tabs on screen are the old realm's (or nothing), and
// writing them — or an inventory-driven pruning of them — under whichever
// realm key is current would corrupt saved state. restoreWorkspaceTabs clears
// it, and so does cancelTabRestore when a switch fails and no restore is coming.
const [awaitingTabRestore, setAwaitingTabRestore] = createSignal(false);

function persistTabs() {
  if (awaitingTabRestore()) return;
  const realm = untrack(tabRealm);
  // Nothing valid can be stored for "no realm assigned yet": an entry under
  // the sentinel is never restored, so the write would just lose the tabs.
  // The first real assignment (setTabRealm, restoreWorkspaceTabs) persists
  // whatever is on screen then — same shape as the awaitingTabRestore gate.
  if (realm === UNASSIGNED_REALM) return;
  savePaneRealm(realm, serializePanes(workspacePanes(), threadByWorkspace()));
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
 * Commit new pane state and follow the focused pane. When the last pane empties
 * on the workspace page there is nothing left to show, so the dashboard takes
 * over rather than an empty "select a workspace" screen.
 */
function commitPanes(next: WorkspacePanesState) {
  setWorkspacePanes(next);
  persistTabs();
  const name = activeWorkspace(next);
  selectRaw(name);
  if (name == null && (activePage() === "workspace" || activePage() === "review")) {
    setActivePage("dashboard");
  }
}

function apply(entry: NavEntry) {
  if (entry.selectedWorkspace != null) {
    setWorkspacePanes(openWorkspace(workspacePanes(), entry.selectedWorkspace));
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
  workspacePanes,
  awaitingTabRestore,
  /** Storage realm of the tabs currently on screen (drafts key off it too). */
  tabRealm,
  tabRealmSession,
  /**
   * Pause tab persistence until the owed restoreWorkspaceTabs call.
   * `daemonSwitch` declares that the restore will land on a different daemon,
   * so it replaces the tab realm session even if no realm was assigned yet.
   */
  deferTabRestore(opts?: { daemonSwitch?: boolean }) {
    if (opts?.daemonSwitch) daemonSwitchPending = true;
    setAwaitingTabRestore(true);
  },
  /**
   * Point persistence at `realm` without touching the tabs on screen, and save
   * them under it now (the startup case: a workspace opened before the realm
   * was known would otherwise never reach this realm's entry).
   */
  setTabRealm(realm: string) {
    assignTabRealm(realm);
    persistTabs();
  },
  /** True while a declared daemon switch is in flight (deferTabRestore's opt). */
  daemonSwitchPending: () => daemonSwitchPending,
  /**
   * Drop the pending-switch bit this attempt introduced on failure, without
   * disturbing an awaitingTabRestore owed by an earlier, still-unresolved
   * switch. Left set, the next startup realm correction would read as a
   * switch and remount the editor over its unsaved text.
   */
  undeclareDaemonSwitch() {
    daemonSwitchPending = false;
  },
  /** Cancel an owed restore after a failed switch, without touching current tabs. */
  cancelTabRestore() {
    // Only called by the attempt that introduced the pause, so no earlier
    // switch is still pending either: still on the same daemon.
    daemonSwitchPending = false;
    setAwaitingTabRestore(false);
    // The pause swallowed any tab change made while the switch was checked —
    // flush it, or quitting now would bring back the pre-switch tabs. Safe
    // here: the switch failed, so the screen still belongs to this realm.
    persistTabs();
  },

  setWindowFocused,
  setChatSurfaceShowsChat,
  /** Select a workspace and switch to its page (clears per-workspace selections). */
  /**
   * Select a workspace and switch to its page. It loads into the focused pane,
   * or the pane that already shows it takes focus.
   */
  selectWorkspace(name: string | null) {
    if (selectedWorkspace() === name && activePage() === "workspace") return;
    pushHistory();
    if (name != null) {
      setWorkspacePanes(openWorkspace(workspacePanes(), name));
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
    const panes = workspacePanes();
    return panes.panes.some(
      (pane, i) => i !== panes.focused && pane.workspace != null && rememberedThread(pane.workspace) === threadId,
    );
  },

  /** True when this chat is the one the focused pane shows, in a focused window. */
  chatThreadFocused(threadId: number): boolean {
    return (
      windowFocused() &&
      activePage() === "workspace" &&
      selectedChatThread() === threadId &&
      chatSurfaceShowsChat()
    );
  },

  /** Focus a pane: its workspace becomes the selected workspace. */
  focusPane(index: number) {
    const next = focusPane(workspacePanes(), index);
    if (next !== workspacePanes()) commitPanes(next);
  },

  /** Close pane `index`; the last pane empties instead of disappearing. */
  closePane(index: number) {
    commitPanes(closePane(workspacePanes(), index));
  },

  /** Close whichever pane shows `name` (archive, delete, sidebar menu). */
  closeWorkspacePane(name: string) {
    commitPanes(closeWorkspace(workspacePanes(), name));
  },

  /**
   * Open `name` beside what is on screen: in a new split, or in the other pane
   * when the view is already split. With nothing else open there is no second
   * pane to make, so it simply opens.
   */
  openWorkspaceInSplit(name: string, direction: SplitDirection) {
    pushHistory();
    commitPanes(splitWorkspace(workspacePanes(), name, direction));
    setActivePage("workspace");
  },

  /** Load `name` into pane `index` (a drop onto that pane), focusing it there. */
  openWorkspaceInPane(name: string, index: number) {
    pushHistory();
    commitPanes(openWorkspaceIn(workspacePanes(), name, index));
    setActivePage("workspace");
  },

  /** Follow a server-side rename: the pane, its chat memory, and the selection. */
  renameWorkspace(from: string, to: string) {
    const memory = threadByWorkspace();
    if (from in memory) {
      const { [from]: thread, ...rest } = memory;
      setThreadByWorkspace({ ...rest, [to]: thread });
    }
    setWorkspacePanes(renamePaneWorkspace(workspacePanes(), from, to));
    persistTabs();
    if (selectedWorkspace() === from) setSelectedWorkspaceRaw(to);
  },

  resetWorkspacePanes() {
    setThreadByWorkspace({});
    commitPanes(emptyPanes());
  },

  /**
   * Swap to `realm`'s saved panes (boot, or a daemon switch). The old realm's
   * state is already on disk — every mutation persists — so this only loads.
   * Stored names are checked against `keep` (the live inventory); whatever
   * survives is committed, and landing on a restored tab switches to the
   * workspace page so the app opens where it was closed.
   */
  restoreWorkspacePanes(realm: string, keep: (name: string) => boolean) {
    // One batch: views keyed on the realm remount once, against the restored
    // selection, not against the old realm's panes in between.
    batch(() => {
      assignTabRealm(realm);
      setAwaitingTabRestore(false);
      const { state, threads } = materializePanes(loadPaneRealm(realm), keep);
      setThreadByWorkspace(threads);
      commitPanes(state);
      // commitPanes's selection short-circuits when the focused workspace kept
      // its name across realms, but the thread ids under it are the new
      // daemon's — point the selection at the restored memory explicitly.
      const active = activeWorkspace(state);
      setSelectedChatThread(active != null ? (threads[active] ?? null) : null);
      if (active != null) setActivePage("workspace");
    });
  },

  /** Drop panes for workspaces that were archived, deleted, or are not on this daemon. */
  retainWorkspacePanes(keep: (name: string) => boolean) {
    const next = retainWorkspaces(workspacePanes(), keep);
    if (next !== workspacePanes()) commitPanes(next);
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
