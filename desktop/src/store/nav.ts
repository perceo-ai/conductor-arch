import { createSignal } from "solid-js";

// Navigation state — mirrors the navigation fields of
// crates/gtk-app/src/state.rs::AppStateSnapshot. Each field is its own signal so
// reading `activePage` does not couple a component to `selectedChatThread`, etc.
// This is the fine-grained equivalent of the AppStateEvent selection events.

export type AppPage = "dashboard" | "workspace" | "history" | "settings" | "review";

const [selectedWorkspace, setSelectedWorkspaceRaw] = createSignal<string | null>(null);
const [activePage, setActivePage] = createSignal<AppPage>("dashboard");
const [selectedChatThread, setSelectedChatThread] = createSignal<number | null>(null);
const [windowFocused, setWindowFocused] = createSignal(true);

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

function apply(entry: NavEntry) {
  if (entry.selectedWorkspace !== selectedWorkspace()) setSelectedChatThread(null);
  setSelectedWorkspaceRaw(entry.selectedWorkspace);
  setActivePage(entry.activePage);
}

export const nav = {
  selectedWorkspace,
  activePage,
  selectedChatThread,
  windowFocused,
  canBack,
  canForward,

  setWindowFocused,
  /** Select a workspace and switch to its page (clears per-workspace selections). */
  selectWorkspace(name: string | null) {
    if (selectedWorkspace() === name && activePage() === "workspace") return;
    pushHistory();
    if (selectedWorkspace() !== name) {
      setSelectedChatThread(null);
    }
    setSelectedWorkspaceRaw(name);
    setActivePage("workspace");
  },

  goToPage(page: AppPage) {
    if (activePage() === page) return;
    pushHistory();
    setActivePage(page);
  },

  selectChatThread(threadId: number | null) {
    setSelectedChatThread(threadId);
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
