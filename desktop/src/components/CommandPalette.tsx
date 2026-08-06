import { For, Show, createEffect, createMemo, createSignal, onCleanup, onMount } from "solid-js";
import { nav, workspacesStore, repositoriesStore, dialogs } from "@/store";
import type { WorkspaceTab } from "@/store/nav";
import { titleCaseWorkspace } from "@/lib/text";
import { fuzzyScore } from "@/lib/fuzzy";

// Command palette — Cmd/Ctrl+K global launcher, ported from the GTK command
// palette (crates/gtk-app command_palette). Fuzzy-filters a flat command list
// spanning page navigation, workspace jumps, workspace-tab switches, and
// create/lifecycle actions. Keyboard-first: ↑/↓ move, Enter runs, Esc closes.

interface Command {
  id: string;
  label: string;
  hint?: string;
  group: string;
  run: () => void;
}

const WORKSPACE_TABS: { tab: WorkspaceTab; label: string }[] = [
  { tab: "chats", label: "Chats" },
  { tab: "changes", label: "Changes" },
  { tab: "review", label: "Review" },
  { tab: "checks", label: "Checks" },
  { tab: "todos", label: "Todos" },
  { tab: "checkpoints", label: "Checkpoints" },
  { tab: "processes", label: "Processes" },
  { tab: "terminal", label: "Terminal" },
];

export default function CommandPalette() {
  const [open, setOpen] = createSignal(false);
  const [query, setQuery] = createSignal("");
  const [cursor, setCursor] = createSignal(0);
  let inputRef: HTMLInputElement | undefined;

  function close() {
    setOpen(false);
    setQuery("");
    setCursor(0);
  }
  function toggle() {
    if (open()) close();
    else {
      setOpen(true);
      queueMicrotask(() => inputRef?.focus());
    }
  }

  onMount(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && (e.key === "k" || e.key === "K")) {
        e.preventDefault();
        toggle();
      } else if (e.key === "Escape" && open()) {
        e.preventDefault();
        close();
      }
    };
    window.addEventListener("keydown", onKey);
    onCleanup(() => window.removeEventListener("keydown", onKey));
  });

  const commands = createMemo<Command[]>(() => {
    const list: Command[] = [];
    // Pages.
    const pages: { page: Parameters<typeof nav.goToPage>[0]; label: string }[] = [
      { page: "dashboard", label: "Dashboard" },
      { page: "projects", label: "Projects" },
      { page: "history", label: "History" },
      { page: "settings", label: "Settings" },
    ];
    for (const p of pages) {
      list.push({
        id: `page:${p.page}`,
        label: `Go to ${p.label}`,
        hint: "Page",
        group: "Navigate",
        run: () => nav.goToPage(p.page),
      });
    }
    // Workspaces.
    for (const name of workspacesStore.state.order) {
      const row = workspacesStore.row(name);
      list.push({
        id: `ws:${name}`,
        label: titleCaseWorkspace(name),
        hint: row?.branch ?? row?.repository,
        group: "Workspaces",
        run: () => nav.selectWorkspace(name),
      });
    }
    // Workspace tabs (only meaningful with a selected workspace).
    const active = nav.selectedWorkspace();
    if (active) {
      for (const t of WORKSPACE_TABS) {
        list.push({
          id: `tab:${t.tab}`,
          label: `${t.label}`,
          hint: titleCaseWorkspace(active),
          group: "Workspace Tab",
          run: () => nav.selectWorkspaceTab(t.tab),
        });
      }
    }
    // Actions.
    list.push({
      id: "action:add-project",
      label: "Add project…",
      hint: "Action",
      group: "Actions",
      run: () => dialogs.open({ kind: "add-project" }),
    });
    const firstRepo = repositoriesStore.state.order[0];
    const repoForNew = (active && workspacesStore.row(active)?.repository) || firstRepo;
    if (repoForNew) {
      list.push({
        id: "action:new-workspace",
        label: `New workspace in ${repoForNew}…`,
        hint: "Action",
        group: "Actions",
        run: () => dialogs.open({ kind: "create-workspace", repository: repoForNew }),
      });
    }
    if (active) {
      list.push({
        id: "action:ws-actions",
        label: "Workspace actions…",
        hint: titleCaseWorkspace(active),
        group: "Actions",
        run: () => dialogs.open({ kind: "workspace-actions", workspace: active }),
      });
    }
    return list;
  });

  const filtered = createMemo<Command[]>(() => {
    const q = query().trim();
    const scored = commands()
      .map((c) => ({ c, s: fuzzyScore(q, `${c.label} ${c.hint ?? ""} ${c.group}`) }))
      .filter((x) => x.s !== null) as { c: Command; s: number }[];
    scored.sort((a, b) => a.s - b.s);
    return scored.map((x) => x.c);
  });

  // Keep the cursor within bounds as the filtered list changes.
  createEffect(() => {
    const n = filtered().length;
    if (cursor() >= n) setCursor(Math.max(0, n - 1));
  });

  function runAt(i: number) {
    const cmd = filtered()[i];
    if (!cmd) return;
    close();
    cmd.run();
  }

  function onInputKey(e: KeyboardEvent) {
    const n = filtered().length;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setCursor((c) => (n === 0 ? 0 : (c + 1) % n));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setCursor((c) => (n === 0 ? 0 : (c - 1 + n) % n));
    } else if (e.key === "Enter") {
      e.preventDefault();
      runAt(cursor());
    }
  }

  return (
    <Show when={open()}>
      <div class="cmdk-overlay" onClick={close}>
        <div class="cmdk-panel" onClick={(e) => e.stopPropagation()}>
          <input
            ref={inputRef}
            class="cmdk-input"
            placeholder="Search commands, workspaces, pages…"
            value={query()}
            onInput={(e) => {
              setQuery(e.currentTarget.value);
              setCursor(0);
            }}
            onKeyDown={onInputKey}
          />
          <div class="cmdk-list">
            <Show
              when={filtered().length > 0}
              fallback={<div class="cmdk-empty">No matches</div>}
            >
              <For each={filtered()}>
                {(cmd, i) => (
                  <button
                    class="cmdk-item"
                    classList={{ "cmdk-item-active": i() === cursor() }}
                    onMouseEnter={() => setCursor(i())}
                    onClick={() => runAt(i())}
                  >
                    <span class="cmdk-item-group">{cmd.group}</span>
                    <span class="cmdk-item-label">{cmd.label}</span>
                    <Show when={cmd.hint}>
                      <span class="cmdk-item-hint">{cmd.hint}</span>
                    </Show>
                  </button>
                )}
              </For>
            </Show>
          </div>
        </div>
      </div>
    </Show>
  );
}
