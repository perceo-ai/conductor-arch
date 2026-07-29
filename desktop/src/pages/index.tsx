import { Show } from "solid-js";
import { nav } from "@/store";
import { DashboardPage } from "./Dashboard";
import CommandCenter from "./CommandCenter";
import { HistoryPage } from "./History";
import { ProjectsPage } from "./Projects";
import { SettingsPage } from "./Settings";

// Each page is a self-contained shell; only the page matching nav.activePage()
// is mounted (see PageStack), so unmounted pages cost nothing.

export function WorkspacePage() {
  return <CommandCenter />;
}

export function PageStack() {
  const page = nav.activePage;
  return (
    <div class="content-area">
      <Show when={page() === "dashboard"}>
        <DashboardPage />
      </Show>
      <Show when={page() === "history"}>
        <HistoryPage />
      </Show>
      <Show when={page() === "workspace" || page() === "review"}>
        <WorkspacePage />
      </Show>
      <Show when={page() === "projects"}>
        <ProjectsPage />
      </Show>
      <Show when={page() === "settings"}>
        <SettingsPage />
      </Show>
    </div>
  );
}
