import { Show } from "solid-js";
import { nav } from "@/store";
import { DashboardPage } from "./Dashboard";
import CommandCenter from "./CommandCenter";

// Placeholder pages for phase 1. Each is a self-contained page shell; later
// phases fill them with the real dashboard/workspace/chat surfaces. Only the
// page matching nav.activePage() is mounted (see PageStack), so unmounted pages
// cost nothing.

function PageShell(props: { title: string; children?: any }) {
  return (
    <div class="page-shell">
      <div class="page-header">
        <div class="text-page-title">{props.title}</div>
      </div>
      <div class="page-body">{props.children}</div>
    </div>
  );
}

export function HistoryPage() {
  return (
    <PageShell title="History">
      <div class="empty-state">Archived workspaces &amp; saved chats — later phase.</div>
    </PageShell>
  );
}

export function WorkspacePage() {
  return <CommandCenter />;
}

export function ProjectsPage() {
  return (
    <PageShell title="Projects">
      <div class="empty-state">Repository management — later phase.</div>
    </PageShell>
  );
}

export function SettingsPage() {
  return (
    <PageShell title="Settings">
      <div class="empty-state">Settings — later phase.</div>
    </PageShell>
  );
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
