import { createSignal, onMount, Show } from "solid-js";
import Sidebar from "./components/Sidebar";
import WindowControls from "./components/WindowControls";
import MetricsOverlay from "./components/MetricsOverlay";
import Dialogs from "./components/Dialogs";
import { PageStack } from "./pages";
import { startStore } from "./store";

export default function App() {
  const [sidebarCollapsed, setSidebarCollapsed] = createSignal(false);

  onMount(() => {
    // Connect the archcar event stream into the reactive store.
    void startStore();
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
      <MetricsOverlay />
    </>
  );
}
