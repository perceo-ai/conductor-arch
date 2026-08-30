import { createEffect, createMemo, createSignal, onCleanup, onMount, Show } from "solid-js";
import Sidebar from "./components/Sidebar";
import WindowControls from "./components/WindowControls";
import MetricsOverlay from "./components/MetricsOverlay";
import Dialogs from "./components/Dialogs";
import SetupModal from "./components/SetupModal";
import Toasts from "./components/Toasts";
import ContextMenu from "./components/ContextMenu";
import CommandPalette from "./components/CommandPalette";
import KeyboardHints from "./components/KeyboardHints";
import ShortcutsHelp from "./components/ShortcutsHelp";
import Icon from "./components/Icon";
import { PageStack } from "./pages";
import { runShellAction } from "./lib/shellAction";
import { providersStore } from "./store/providers";
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
  layoutStore,
} from "./store";
import { openExternal } from "./bridge/client";
import { ACCENT_HEX } from "./store/prefs";
import { installExternalLinkHandler } from "./lib/externalLinks";
import {
  parseKeybindingOverrides,
  resolveShortcut,
  shortcutForAction,
  type ShortcutAction,
} from "./lib/shortcuts";

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
  "toggle-theme",
  "toggle-right-panel",
  "archive-workspace",
  "merge-pr",
  "push-branch",
  "open-pr-github",
  "start-review",
  "edit-layout",
  "show-uncommitted",
  "show-files",
  "show-checks",
  "show-summary",
  "open-in-app",
  "open-menu",
  "copy-link",
  "switch-workspace-1",
  "switch-workspace-2",
  "switch-workspace-3",
  "switch-workspace-4",
  "switch-workspace-5",
  "switch-workspace-6",
  "switch-workspace-7",
  "switch-workspace-8",
  "switch-workspace-9",
]);

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName.toLowerCase();
  return tag === "input" || tag === "textarea" || tag === "select";
}

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
    void startStore().then(() => {
      setupStore.check().catch(() => undefined);
      // The provider registry belongs to whichever daemon we are pointed at, so
      // it is pulled per connection rather than baked into the renderer.
      providersStore.load().catch(() => undefined);
    });
  });

  // Links inside rendered markdown (chat, plans, briefings) are real anchors;
  // without this they navigate the renderer away from the app shell.
  onMount(() => {
    const dispose = installExternalLinkHandler(document, (url) => void openExternal(url));
    onCleanup(dispose);
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

  function moveWorkspace(delta: 1 | -1) {
    const names = workspacesStore.state.order.filter((name) => workspacesStore.row(name)?.status !== "archived");
    if (names.length === 0) return;
    const current = nav.selectedWorkspace();
    const index = current ? names.indexOf(current) : -1;
    const next = names[(Math.max(0, index) + delta + names.length) % names.length];
    nav.selectWorkspace(next);
    queueMicrotask(() => focusFirst(["[data-focus-target='workspace-main']", ".page-shell"]));
  }

  function selectWorkspaceSlot(action: ShortcutAction) {
    const match = /^switch-workspace-(\d)$/.exec(action);
    if (!match) return false;
    const names = workspacesStore.state.order.filter((name) => workspacesStore.row(name)?.status !== "archived");
    const name = names[Number(match[1]) - 1];
    if (!name) return true;
    nav.selectWorkspace(name);
    queueMicrotask(() => focusFirst(["[data-focus-target='workspace-main']", ".page-shell"]));
    return true;
  }

  function activeWorkspace() {
    const name = nav.selectedWorkspace();
    return name ? workspacesStore.row(name) : undefined;
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
      if (e.key === "Escape" && layoutStore.editing()) {
        e.preventDefault();
        layoutStore.setEditing(false);
        return;
      }
      if (isTypingTarget(e.target)) return;
      const action = resolveShortcut(e, activeShortcuts());
      if (!action || action === "open-palette") return;
      if (!GLOBAL_SHORTCUT_ACTIONS.has(action)) return;
      e.preventDefault();
      if (selectWorkspaceSlot(action)) return;
      switch (action) {
        case "toggle-theme":
          prefsStore.setTheme(prefsStore.state.theme === "dark" ? "light" : "dark");
          break;
        case "toggle-sidebar":
          setSidebarCollapsed((c) => !c);
          break;
        case "toggle-right-panel":
          layoutStore.toggleSidePanel();
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
            actions.revealPanel("changes");
          }
          break;
        }
        case "create-pr": {
          const active = nav.selectedWorkspace();
          if (active) void actions.refreshPullRequest(active);
          break;
        }
        case "archive-workspace": {
          const active = nav.selectedWorkspace();
          if (active) void actions.archiveWorkspace(active);
          break;
        }
        case "merge-pr": {
          const active = nav.selectedWorkspace();
          if (active) void actions.mergePullRequest(active);
          break;
        }
        case "push-branch": {
          const active = nav.selectedWorkspace();
          if (active) void actions.pushBranch(active);
          break;
        }
        case "open-pr-github": {
          const url = activeWorkspace()?.prUrl;
          if (url) void openExternal(url);
          break;
        }
        case "start-review":
          window.dispatchEvent(new CustomEvent("archductor:start-review"));
          break;
        case "edit-layout":
          layoutStore.setEditing(true);
          break;
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
          layoutStore.cyclePanel(1);
          break;
        case "prev-panel":
          layoutStore.cyclePanel(-1);
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
          actions.revealPanel("terminal");
          window.dispatchEvent(new CustomEvent("archductor:toggle-terminal-dock"));
          break;
        case "show-uncommitted": {
          const active = nav.selectedWorkspace();
          if (active) {
            nav.selectWorkspace(active);
            actions.revealPanel("changes");
          }
          break;
        }
        case "show-files": {
          const active = nav.selectedWorkspace();
          if (active) {
            nav.selectWorkspace(active);
            actions.revealPanel("files");
          }
          break;
        }
        case "show-checks": {
          const active = nav.selectedWorkspace();
          if (active) {
            nav.selectWorkspace(active);
            actions.revealPanel("checks");
          }
          break;
        }
        case "show-summary": {
          const active = nav.selectedWorkspace();
          if (active) {
            nav.selectWorkspace(active);
            actions.revealPanel("summary");
          }
          break;
        }
        case "open-in-app": {
          const path = activeWorkspace()?.path;
          if (path) runShellAction("Open workspace", openExternal(path));
          break;
        }
        case "open-menu":
          window.dispatchEvent(new CustomEvent("archductor:open-workspace-menu"));
          break;
        case "copy-link": {
          const row = activeWorkspace();
          const target = row?.prUrl ?? row?.path;
          if (target) void navigator.clipboard?.writeText(target).catch(() => undefined);
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
        {/* Settings brings its own left column and takes over the window;
            showing both would put two navigation rails side by side. */}
        <Show when={nav.activePage() !== "settings"}>
          <Sidebar
            collapsed={sidebarCollapsed()}
            onToggle={() => setSidebarCollapsed((c) => !c)}
          />
          <Show when={sidebarCollapsed()}>
            <button
              class="ui-button-icon reopen-sidebar"
              data-shortcut={shortcutForAction("toggle-sidebar", activeShortcuts())}
              onClick={() => setSidebarCollapsed(false)}
            >
              <Icon name="panel-right" />
            </button>
          </Show>
        </Show>
        <PageStack />
      </div>
      <Dialogs />
      <SetupModal />
      <Toasts />
      <ContextMenu />
      <CommandPalette />
      <KeyboardHints />
      <ShortcutsHelp
        open={helpOpen()}
        shortcuts={activeShortcuts()}
        onClose={() => setHelpOpen(false)}
      />
      <MetricsOverlay />
    </>
  );
}
