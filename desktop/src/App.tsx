import { createEffect, createSignal, onMount, Show } from "solid-js";
import Sidebar from "./components/Sidebar";
import WindowControls from "./components/WindowControls";
import MetricsOverlay from "./components/MetricsOverlay";
import Dialogs from "./components/Dialogs";
import SetupModal from "./components/SetupModal";
import Toasts from "./components/Toasts";
import ContextMenu from "./components/ContextMenu";
import CommandPalette from "./components/CommandPalette";
import { PageStack } from "./pages";
import { startStore, setupStore, prefsStore } from "./store";
import { ACCENT_HEX } from "./store/prefs";

export default function App() {
  const [sidebarCollapsed, setSidebarCollapsed] = createSignal(false);

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
      <MetricsOverlay />
    </>
  );
}
