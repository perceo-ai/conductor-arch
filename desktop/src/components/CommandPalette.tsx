import {
  For,
  Show,
  createEffect,
  createMemo,
  createResource,
  createSignal,
  onCleanup,
  onMount,
} from "solid-js";
import { nav, workspacesStore, repositoriesStore, dialogs, prefsStore, uiStore, actions } from "@/store";
import type { Accent } from "@/store/prefs";
import { workspacePanels } from "@/lib/panelRegistry";
import { titleCaseWorkspace } from "@/lib/text";
import { fuzzyScore } from "@/lib/fuzzy";
import {
  parseKeybindingOverrides,
  resolveShortcut,
  shortcutForAction,
  type ShortcutAction,
} from "@/lib/shortcuts";
import { send } from "@/bridge/client";
import { openFileInCenter } from "@/pages/openFileBridge";

// Command palette — customizable global launcher, ported from the GTK command
// palette (crates/gtk-app command_palette). Fuzzy-filters a flat command list
// spanning page navigation, workspace jumps, workspace-tab switches, and
// create/lifecycle actions. Keyboard-first: ↑/↓ move, Enter runs, Esc closes.

interface Command {
  id: string;
  label: string;
  hint?: string;
  group: string;
  shortcut?: ShortcutAction;
  run: () => void;
}

const PANEL_SHORTCUTS: Partial<Record<string, ShortcutAction>> = {
  changes: "show-changes",
  files: "show-files",
  checks: "show-checks",
  summary: "show-summary",
  terminal: "toggle-terminal",
};

export default function CommandPalette() {
  const [open, setOpen] = createSignal(false);
  const [query, setQuery] = createSignal("");
  const [cursor, setCursor] = createSignal(0);
  const activeShortcuts = createMemo(() => parseKeybindingOverrides(prefsStore.state.keybindings));
  let inputRef: HTMLInputElement | undefined;
  let panelRef: HTMLDivElement | undefined;
  let previousFocus: HTMLElement | undefined;

  function close() {
    const restore = previousFocus;
    setOpen(false);
    setQuery("");
    setCursor(0);
    previousFocus = undefined;
    queueMicrotask(() => {
      if (restore?.isConnected && !restore.matches(":disabled, [aria-disabled='true']")) {
        restore.focus();
        if (document.activeElement === restore) return;
      }
      const fallback = document.querySelector<HTMLElement>(
        "[data-focus-target='workspace-main'], .settings-search input, .page-shell, .settings-main, main",
      );
      fallback?.focus();
    });
  }
  function openPalette() {
    if (!open()) {
      const active = document.activeElement;
      previousFocus = active instanceof HTMLElement ? active : undefined;
      setOpen(true);
    }
    queueMicrotask(() => inputRef?.focus());
  }
  function toggle() {
    if (open()) close();
    else openPalette();
  }

  onMount(() => {
    const onKey = (e: KeyboardEvent) => {
      const action = resolveShortcut(e, activeShortcuts());
      if (action === "open-palette" || action === "quick-open") {
        e.preventDefault();
        toggle();
      } else if (e.key === "Escape" && open()) {
        e.preventDefault();
        close();
      }
    };
    const onOpen = () => openPalette();
    window.addEventListener("keydown", onKey);
    window.addEventListener("archductor:open-command-palette", onOpen);
    onCleanup(() => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("archductor:open-command-palette", onOpen);
    });
  });

  // Make the palette a true modal keyboard surface. Electron supports inert;
  // the focusin guard also keeps focus contained for programmatic focus moves.
  createEffect(() => {
    if (!open()) return;
    const background = document.querySelector<HTMLElement>(".window-content");
    background?.setAttribute("inert", "");
    const containFocus = (event: FocusEvent) => {
      if (panelRef?.contains(event.target as Node)) return;
      inputRef?.focus();
    };
    document.addEventListener("focusin", containFocus);
    onCleanup(() => {
      background?.removeAttribute("inert");
      document.removeEventListener("focusin", containFocus);
    });
  });

  // Fuzzy file open: load the selected workspace's file
  // list while the palette is open, and surface "Open <path>" commands once the
  // user starts typing so they don't bury navigation on the empty palette.
  const [files] = createResource(
    () => (open() ? nav.selectedWorkspace() : null),
    async (ws): Promise<string[]> => {
      try {
        const res = await send({ type: "list_workspace_files", workspace: ws });
        return res.type === "workspace_files" ? res.files : [];
      } catch {
        return [];
      }
    },
  );

  const commands = createMemo<Command[]>(() => {
    const list: Command[] = [];
    // Pages.
    const pages: { page: Parameters<typeof nav.goToPage>[0]; label: string; shortcut: ShortcutAction }[] = [
      { page: "dashboard", label: "Dashboard", shortcut: "goto-dashboard" },
      { page: "history", label: "History", shortcut: "goto-history" },
      { page: "settings", label: "Settings", shortcut: "goto-settings" },
    ];
    for (const p of pages) {
      list.push({
        id: `page:${p.page}`,
        label: `Go to ${p.label}`,
        hint: "Page",
        group: "Navigate",
        shortcut: p.shortcut,
        run: () => nav.goToPage(p.page),
      });
    }
    // Workspaces.
    for (const [index, name] of workspacesStore.state.order.entries()) {
      const row = workspacesStore.row(name);
      list.push({
        id: `ws:${name}`,
        label: titleCaseWorkspace(name),
        hint: row?.branch ?? row?.repository,
        group: "Workspaces",
        shortcut: index < 9 ? `switch-workspace-${index + 1}` as ShortcutAction : undefined,
        run: () => nav.selectWorkspace(name),
      });
    }
    // Workspace panels are generated from the live registry so hidden and
    // dynamically registered surfaces always retain a keyboard path.
    const active = nav.selectedWorkspace();
    if (active) {
      for (const panel of workspacePanels()) {
        list.push({
          id: `panel:${panel.id}`,
          label: `Show: ${panel.title}`,
          hint: titleCaseWorkspace(active),
          group: "Panels",
          shortcut: PANEL_SHORTCUTS[panel.id],
          run: () => {
            nav.selectWorkspace(active);
            actions.revealPanel(panel.id);
          },
        });
      }
    }
    // Appearance + help — make the palette a real control surface.
    list.push({
      id: "appearance:theme",
      label: `Switch to ${prefsStore.state.theme === "dark" ? "light" : "dark"} theme`,
      hint: "Appearance",
      group: "Appearance",
      shortcut: "toggle-theme",
      run: () => prefsStore.setTheme(prefsStore.state.theme === "dark" ? "light" : "dark"),
    });
    const ACCENTS: Accent[] = ["amber", "blue", "green", "rose"];
    const nextAccent = ACCENTS[(ACCENTS.indexOf(prefsStore.state.accent) + 1) % ACCENTS.length];
    list.push({
      id: "appearance:accent",
      label: `Cycle accent → ${nextAccent}`,
      hint: "Appearance",
      group: "Appearance",
      run: () => prefsStore.setAccent(nextAccent),
    });
    list.push({
      id: "help:shortcuts",
      label: "Keyboard shortcuts",
      hint: "Help",
      group: "Help",
      shortcut: "show-help",
      run: () => uiStore.setHelpOpen(true),
    });
    list.push({
      id: "help:customize-shortcuts",
      label: "Customize keyboard bindings",
      hint: "Settings",
      group: "Help",
      run: () => nav.goToPage("settings"),
    });
    // Actions.
    list.push({
      id: "action:add-project",
      label: "Add project…",
      hint: "Action",
      group: "Actions",
      shortcut: "add-project",
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
        shortcut: "new-workspace",
        run: () => dialogs.open({ kind: "create-workspace", repository: repoForNew }),
      });
    }
    if (active) {
      list.push({
        id: "action:ws-actions",
        label: "Workspace actions…",
        hint: titleCaseWorkspace(active),
        group: "Actions",
        shortcut: "workspace-actions",
        run: () => dialogs.open({ kind: "workspace-actions", workspace: active }),
      });
    }
    // File open — only once the user is typing, capped so a huge repo cannot
    // flood the list (fuzzy ranking still surfaces the best matches).
    if (active && query().trim()) {
      const ws = active;
      for (const path of (files() ?? []).slice(0, 500)) {
        list.push({
          id: `file:${path}`,
          label: path,
          hint: "Open",
          group: "File",
          run: () => {
            nav.selectWorkspace(ws);
            queueMicrotask(() => openFileInCenter(ws, path));
          },
        });
      }
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
    } else if (e.key === "Tab") {
      // Results use arrows rather than Tab, leaving one stable focus stop and
      // preventing the browser from escaping the modal surface.
      e.preventDefault();
      inputRef?.focus();
    }
  }

  return (
    <Show when={open()}>
      <div class="cmdk-overlay" onClick={close}>
        <div
          ref={panelRef}
          class="cmdk-panel"
          role="dialog"
          aria-modal="true"
          aria-label="Command palette"
          onClick={(e) => e.stopPropagation()}
        >
          <input
            ref={inputRef}
            class="cmdk-input"
            role="combobox"
            aria-controls="cmdk-listbox"
            aria-expanded="true"
            aria-autocomplete="list"
            aria-activedescendant={filtered()[cursor()] ? `cmdk-option-${cursor()}` : undefined}
            placeholder="Search commands, workspaces, pages…"
            value={query()}
            onInput={(e) => {
              setQuery(e.currentTarget.value);
              setCursor(0);
            }}
            onKeyDown={onInputKey}
          />
          <div id="cmdk-listbox" class="cmdk-list" role="listbox">
            <Show
              when={filtered().length > 0}
              fallback={<div class="cmdk-empty">No matches</div>}
            >
              <For each={filtered()}>
                {(cmd, i) => (
                  <button
                    id={`cmdk-option-${i()}`}
                    class="cmdk-item"
                    classList={{ "cmdk-item-active": i() === cursor() }}
                    role="option"
                    aria-selected={i() === cursor()}
                    tabIndex={-1}
                    data-shortcut={cmd.shortcut ? shortcutForAction(cmd.shortcut, activeShortcuts()) : undefined}
                    onMouseEnter={() => setCursor(i())}
                    onClick={() => runAt(i())}
                  >
                    <span class="cmdk-item-group">{cmd.group}</span>
                    <span class="cmdk-item-label">{cmd.label}</span>
                    <Show when={cmd.hint}>
                      <span class="cmdk-item-hint">{cmd.hint}</span>
                    </Show>
                    <Show when={cmd.shortcut && shortcutForAction(cmd.shortcut, activeShortcuts())}>
                      <kbd class="cmdk-item-shortcut">
                        {shortcutForAction(cmd.shortcut!, activeShortcuts())}
                      </kbd>
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
