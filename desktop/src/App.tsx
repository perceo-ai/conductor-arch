import { createEffect, createMemo, createSignal, onCleanup, onMount, Show } from "solid-js";
import Sidebar from "./components/Sidebar";
import WindowControls from "./components/WindowControls";
import MetricsOverlay from "./components/MetricsOverlay";
import Dialogs from "./components/Dialogs";
import SetupModal from "./components/SetupModal";
import Toasts from "./components/Toasts";
import ContextMenu from "./components/ContextMenu";
import CommandPalette from "./components/CommandPalette";
import ShortcutsHelp from "./components/ShortcutsHelp";
import Icon from "./components/Icon";
import { PageStack } from "./pages";
import {
  startStore,
  setupStore,
  prefsStore,
  nav,
  uiStore,
  dialogs,
  actions,
  workspacesStore,
  repositoriesStore,
} from "./store";
import { ACCENT_HEX } from "./store/prefs";
import { PRODUCT_RIGHT_PANEL_TABS } from "./lib/rightPanelTabs";
import { parseKeybindingOverrides, resolveShortcut, type ShortcutAction } from "./lib/shortcuts";

const GLOBAL_SHORTCUT_ACTIONS = new Set<ShortcutAction>([
  "toggle-sidebar",
  "nav-back",
  "nav-forward",
  "goto-dashboard",
  "goto-history",
  "goto-settings",
  "show-help",
  "new-workspace",
  "show-changes",
  "create-pr",
  "focus-composer",
  "focus-workspace",
  "focus-search",
  "next-panel",
  "prev-panel",
  "next-workspace",
  "prev-workspace",
  "workspace-actions",
  "add-project",
  "new-chat",
  "toggle-terminal",
]);

export default function App() {
  const [sidebarCollapsed, setSidebarCollapsedRaw] = createSignal(prefsStore.state.sidebarCollapsed);
  const setSidebarCollapsed = (next: boolean | ((c: boolean) => boolean)) => {
    setSidebarCollapsedRaw((prev) => {
      const value = typeof next === "function" ? next(prev) : next;
      prefsStore.setSidebarCollapsed(value);
      return value;
    });
  };
  const helpOpen = uiStore.helpOpen;
  const setHelpOpen = uiStore.setHelpOpen;
  const activeShortcuts = createMemo(() => parseKeybindingOverrides(prefsStore.state.keybindings));

  // Apply appearance prefs (theme/accent/density) to the document body — the
  // theme.css class hooks (lc-theme-*, lc-accent-*, lc-density-*) are already
  // defined; this restores the GTK runtime controls that toggle them.
  createEffect(() => {
    const body = document.body;
    body.classList.toggle("lc-theme-dark", prefsStore.state.theme === "dark");
    body.classList.toggle("lc-theme-light", prefsStore.state.theme === "light");
    for (const a of ["amber", "blue", "green", "rose"]) {
      body.classList.toggle(`lc-accent-${a}`, prefsStore.state.accent === a);
    }
    for (const d of ["compact", "comfortable"]) {
      body.classList.toggle(`lc-density-${d}`, prefsStore.state.density === d);
    }
    document.documentElement.style.setProperty("--lc-accent", ACCENT_HEX[prefsStore.state.accent]);
  });

  onMount(() => {
    // Connect the archcar event stream into the reactive store, then probe host
    // setup readiness. A blocking modal gates the app until setup is complete.
    void startStore().then(() => setupStore.check().catch(() => undefined));
  });

  function focusFirst(selectors: string[]) {
    for (const selector of selectors) {
      const el = document.querySelector<HTMLElement>(selector);
      if (el) {
        el.focus();
        return true;
      }
    }
    return false;
  }

  function moveRightPanel(delta: 1 | -1) {
    const current = nav.rightPanelTab();
    const tabs = PRODUCT_RIGHT_PANEL_TABS.map((tab) => tab.id);
    const index = Math.max(0, tabs.indexOf(current));
    nav.setRightPanelTab(tabs[(index + delta + tabs.length) % tabs.length]);
    queueMicrotask(() => focusFirst(["[data-focus-target='workspace-panel']", "[data-focus-target='workspace-main']"]));
  }

  function moveWorkspace(delta: 1 | -1) {
    const names = workspacesStore.state.order.filter((name) => workspacesStore.row(name)?.status !== "archived");
    if (names.length === 0) return;
    const current = nav.selectedWorkspace();
    const index = current ? names.indexOf(current) : -1;
    const next = names[(Math.max(0, index) + delta + names.length) % names.length];
    nav.selectWorkspace(next);
    queueMicrotask(() => focusFirst(["[data-focus-target='workspace-main']", ".page-shell"]));
  }

  // Global keyboard shortcuts (GTK parity plus keyboard-first focus movement).
  // The command palette owns "open-palette", so this handler skips it.
  onMount(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && helpOpen()) {
        e.preventDefault();
        setHelpOpen(false);
        return;
      }
      const action = resolveShortcut(e, activeShortcuts());
      if (!action || action === "open-palette") return;
      if (!GLOBAL_SHORTCUT_ACTIONS.has(action)) return;
      e.preventDefault();
      switch (action) {
        case "toggle-sidebar":
          setSidebarCollapsed((c) => !c);
          break;
        case "nav-back":
          nav.back();
          break;
        case "nav-forward":
          nav.forward();
          break;
        case "goto-dashboard":
          nav.goToPage("dashboard");
          break;
        case "goto-history":
          nav.goToPage("history");
          break;
        case "goto-settings":
          nav.goToPage("settings");
          break;
        case "show-help":
          setHelpOpen((o) => !o);
          break;
        case "new-workspace": {
          const active = nav.selectedWorkspace();
          const repo =
            (active && workspacesStore.row(active)?.repository) ||
            repositoriesStore.state.order[0];
          if (repo) dialogs.open({ kind: "create-workspace", repository: repo });
          break;
        }
        case "show-changes": {
          const active = nav.selectedWorkspace();
          if (active) {
            nav.selectWorkspace(active);
            nav.setRightPanelTab("changes");
          }
          break;
        }
        case "create-pr": {
          const active = nav.selectedWorkspace();
          if (active) void actions.refreshPullRequest(active);
          break;
        }
        case "focus-composer":
          focusFirst(["[data-focus-target='chat-composer']", ".chat-input-view"]);
          break;
        case "focus-workspace":
          focusFirst(["[data-focus-target='workspace-main']", ".page-shell"]);
          break;
        case "focus-search":
          setSidebarCollapsed(false);
          queueMicrotask(() => focusFirst(["[data-focus-target='sidebar-search']", ".sidebar-search", ".sidebar-search-minimal"]));
          break;
        case "next-panel":
          moveRightPanel(1);
          break;
        case "prev-panel":
          moveRightPanel(-1);
          break;
        case "next-workspace":
          moveWorkspace(1);
          break;
        case "prev-workspace":
          moveWorkspace(-1);
          break;
        case "workspace-actions": {
          const active = nav.selectedWorkspace();
          if (active) dialogs.open({ kind: "workspace-actions", workspace: active });
          break;
        }
        case "add-project":
          dialogs.open({ kind: "add-project" });
          break;
        case "new-chat":
          window.dispatchEvent(new CustomEvent("archductor:new-chat"));
          break;
        case "toggle-terminal":
          window.dispatchEvent(new CustomEvent("archductor:toggle-terminal-dock"));
          break;
      }
    };
    window.addEventListener("keydown", onKey);
    onCleanup(() => window.removeEventListener("keydown", onKey));
  });

  return (
    <>
      <Show when={!navigator.userAgent.includes("Mac")}>
        <WindowControls />
      </Show>
      <div class="window-content">
        <Sidebar
          collapsed={sidebarCollapsed()}
          onToggle={() => setSidebarCollapsed((c) => !c)}
        />
        <Show when={sidebarCollapsed()}>
          <button class="ui-button-icon reopen-sidebar" onClick={() => setSidebarCollapsed(false)}>
            <Icon name="panel-right" />
          </button>
        </Show>
        <PageStack />
      </div>
      <Dialogs />
      <SetupModal />
      <Toasts />
      <ContextMenu />
      <CommandPalette />
      <ShortcutsHelp
        open={helpOpen()}
        shortcuts={activeShortcuts()}
        onClose={() => setHelpOpen(false)}
      />
      <MetricsOverlay />
    </>
  );
}
