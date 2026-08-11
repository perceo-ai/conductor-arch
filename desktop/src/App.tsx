import { createEffect, createSignal, onCleanup, onMount, Show } from "solid-js";
import Sidebar from "./components/Sidebar";
import WindowControls from "./components/WindowControls";
import MetricsOverlay from "./components/MetricsOverlay";
import Dialogs from "./components/Dialogs";
import SetupModal from "./components/SetupModal";
import Toasts from "./components/Toasts";
import ContextMenu from "./components/ContextMenu";
import CommandPalette from "./components/CommandPalette";
import ShortcutsHelp from "./components/ShortcutsHelp";
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
import { resolveShortcut } from "./lib/shortcuts";

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

  // Global keyboard shortcuts (GTK parity). The command palette owns Cmd/Ctrl+K
  // itself, so this handler skips "open-palette" to avoid double-toggling.
  onMount(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && helpOpen()) {
        e.preventDefault();
        setHelpOpen(false);
        return;
      }
      const action = resolveShortcut(e);
      if (!action || action === "open-palette") return;
      const target = e.target as HTMLElement | null;
      const editable =
        !!target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.isContentEditable);
      // Only the unmodified "?" help is suppressed while typing; modifier chords
      // still fire so they work from anywhere.
      if (action === "show-help" && editable) return;
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
        case "goto-projects":
          nav.goToPage("projects");
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
            ⇥
          </button>
        </Show>
        <PageStack />
      </div>
      <Dialogs />
      <SetupModal />
      <Toasts />
      <ContextMenu />
      <CommandPalette />
      <ShortcutsHelp open={helpOpen()} onClose={() => setHelpOpen(false)} />
      <MetricsOverlay />
    </>
  );
}
