import { For, Match, Show, Switch, createEffect, createResource, createSignal, onCleanup, onMount } from "solid-js";
import { send } from "@/bridge/client";
import { terminalStore, nav, threadsStore, toastsStore, workspacesStore } from "@/store";
import TerminalPanel from "./TerminalPanel";
import type { ArchcarRunScript } from "@/bridge/protocol";
import { runScriptAvailabilityLabel, runScriptStatusText, scriptConsoleActions } from "@/lib/runScripts";
import { ansiToHtml } from "@/lib/ansi";
import ResizeHandle from "@/components/ResizeHandle";
import { createPersistedWidth } from "@/lib/persistedWidth";
import Icon from "@/components/Icon";

// Right-panel bottom region — port of the GTK run console (ws_run_console). A
// collapsible dock whose tab strip holds two prompt tabs (Setup, Run) plus any
// number of PTY-backed terminals. Setup/Run show the generated "build this
// script" prompt and queue it into the active chat; terminals are spawned lazily
// so an unopened workspace never starts a process.

const MAX_TERMINALS = 6;
const DOCK_MIN = 120;
const DOCK_MAX = 700;
const DOCK_EXPANDED_KEY = "archductor.terminalDock.expanded";

// Active tab is either a prompt tab or a specific terminal id.
type RunTab = "setup" | "run" | { term: string };

function providerKind(provider: string): "codex" | "claude" | "shell" {
  return provider === "claude" || provider === "shell" ? provider : "codex";
}

function RunScriptsList(props: { workspace: string }) {
  const [scripts] = createResource(
    () => props.workspace,
    async (workspace) => {
      try {
        const res = await send({ type: "get_workspace_run_scripts", workspace });
        return res.type === "workspace_run_scripts" ? res.scripts : [];
      } catch {
        return [] as ArchcarRunScript[];
      }
    },
  );

  return (
    <Show when={(scripts() ?? []).length > 0}>
      <div class="ws-run-script-list" aria-label="Configured run scripts">
        <For each={scripts() ?? []}>
          {(script) => (
            <div
              class="ws-run-script-row"
              classList={{ "ws-run-script-disabled": !script.runnable_here }}
              title={runScriptStatusText(script)}
            >
              <div class="ws-run-script-main">
                <span class="ws-run-script-id">{script.id}</span>
                <Show when={script.default}>
                  <span class="ws-run-script-badge">Default</span>
                </Show>
              </div>
              <div class="ws-run-script-meta">
                <span class="ws-run-script-env">{runScriptAvailabilityLabel(script)}</span>
                <span class="ws-run-script-status">{runScriptStatusText(script)}</span>
              </div>
            </div>
          )}
        </For>
      </div>
    </Show>
  );
}

// Setup/Run prompt tab: fetches the workspace's script-build prompt and queues it
// into the selected chat as a draft (GTK's workspace_prompt_tab_view).
function PromptTab(props: { workspace: string; kind: "setup" | "run" }) {
  const [prompt] = createResource(
    () => [props.workspace, props.kind] as const,
    async ([ws, kind]) => {
      try {
        const res = await send({ type: "get_workspace_script_prompt", workspace: ws, kind });
        return res.type === "workspace_script_prompt" ? res.prompt : "";
      } catch {
        return "";
      }
    },
  );
  const heading = () => (props.kind === "setup" ? "Setup Prompt" : "Run Prompt");
  const modalTitle = () => (props.kind === "setup" ? "Build Setup Script" : "Build Run Script");
  const buttonLabel = () => (props.kind === "setup" ? "Queue Bootstrap Draft" : "Queue Launch Draft");
  const startLabel = () => (props.kind === "setup" ? "Run Setup" : "Run Default");
  const [starting, setStarting] = createSignal(false);
  const [stopping, setStopping] = createSignal(false);

  async function startScript() {
    if (starting()) return;
    setStarting(true);
    try {
      const res = await send(
        props.kind === "setup"
          ? { type: "start_workspace_setup", workspace: props.workspace }
          : { type: "start_workspace_run", workspace: props.workspace },
      );
      if (res.type === "workspace_process_started") {
        toastsStore.push(`${startLabel()} started as pid ${res.process.pid}.`, "info");
      } else if (res.type === "error") {
        toastsStore.push(res.message, "error");
      }
    } catch (err) {
      toastsStore.push(err instanceof Error ? err.message : "Unable to start script.", "error");
    } finally {
      setStarting(false);
      void refetchLog();
    }
  }

  async function stopRun() {
    if (stopping()) return;
    setStopping(true);
    try {
      const res = await send({ type: "stop_workspace_run", workspace: props.workspace });
      if (res.type === "workspace_process_stopped") {
        toastsStore.push(`Run stopped for pid ${res.process.pid}.`, "info");
      } else if (res.type === "error") {
        toastsStore.push(res.message, "error");
      }
    } catch (err) {
      toastsStore.push(err instanceof Error ? err.message : "Unable to stop run.", "error");
    } finally {
      setStopping(false);
      // The poll only runs while `running` is true, so a stop would otherwise
      // leave the last line of output permanently missing.
      void refetchLog();
    }
  }

  function queueDraft() {
    const text = (prompt() ?? "").trim();
    if (!text) return;
    const tid = nav.selectedChatThread();
    const thread = tid != null ? threadsStore.list(props.workspace).find((t) => t.id === tid) : undefined;
    if (!thread) {
      toastsStore.push("Open a chat to queue this prompt.", "info");
      return;
    }
    void send({
      type: "queue_chat_input",
      thread_id: thread.id,
      input: text,
      visible_input: text,
      kind: "user",
      session_kind: providerKind(thread.provider),
    })
      .then(() => toastsStore.push(`${heading()} queued to chat.`, "info"))
      .catch(() => {});
  }

  // The console shows live output when a script has produced any, and falls
  // back to the generated build-this-script prompt when it has not — which is
  // the state a workspace with no script yet is permanently in.
  const [log, { refetch: refetchLog }] = createResource(
    () => props.workspace,
    async (ws): Promise<string> => {
      try {
        const res = await send({ type: "get_run_log", workspace: ws });
        return res.type === "run_log" ? res.log : "";
      } catch {
        return "";
      }
    },
  );

  const running = () => Boolean(workspacesStore.row(props.workspace)?.runRunning);
  const actions = () =>
    scriptConsoleActions({
      kind: props.kind,
      running: running(),
      pending: starting() || stopping(),
      prompt: prompt() ?? "",
    });

  // Poll only while something is actually running, so an idle dock is silent.
  createEffect(() => {
    if (!running()) return;
    const timer = setInterval(() => void refetchLog(), 1500);
    onCleanup(() => clearInterval(timer));
  });

  const body = () => (log() ?? "").trim();

  return (
    <div class="ws-run-panel">
      <div class="ws-run-console-head">
        <span class="detail-label">{heading()}</span>
        <Show when={running()}>
          <span class="ws-run-live" title="A run script is running">
            <span class="ws-run-live-dot" />
            Running
          </span>
        </Show>
      </div>
      <Show when={props.kind === "run"}>
        <RunScriptsList workspace={props.workspace} />
      </Show>
      {/* Styled as a terminal rather than a prose block: this is command output,
          and ANSI in it should render as colour instead of as escape codes. */}
      <Show
        when={body()}
        fallback={
          <pre class="ws-run-console ws-run-console-idle">
            {prompt.loading ? "Loading…" : prompt() || "No output yet."}
          </pre>
        }
      >
        <pre class="ws-run-console" innerHTML={ansiToHtml(body())} />
      </Show>
      <div class="ws-run-prompt-actions">
        <span class="ws-run-modal-title">{modalTitle()}</span>
        {/* Start and stop are mutually exclusive, and a pending request hides
            both — a control that cannot act is worse than an absent one. */}
        <Show when={actions().canStart}>
          <button class="ui-button-secondary" onClick={() => void startScript()}>
            {startLabel()}
          </button>
        </Show>
        <Show when={actions().canStop}>
          <button class="ui-button-secondary" onClick={() => void stopRun()}>
            Stop Run
          </button>
        </Show>
        <Show when={starting() || stopping()}>
          <span class="ws-run-pending">{starting() ? "Starting…" : "Stopping…"}</span>
        </Show>
        <Show when={actions().canQueueDraft}>
          <button class="suggested-action" onClick={queueDraft}>
            {buttonLabel()}
          </button>
        </Show>
      </div>
    </div>
  );
}

export default function TerminalDock(props: { workspace: string }) {
  // Open by default. It was collapsed on the theory that chat is primary and
  // the dock is a drawer, but the terminal and the setup/run consoles are part
  // of the normal loop, and a collapsed dock hides that they exist at all. An
  // explicit collapse still persists — only the never-touched case changed.
  const stored = localStorage.getItem(DOCK_EXPANDED_KEY);
  const [expanded, setExpandedRaw] = createSignal(stored === null ? true : stored === "1");
  const setExpanded = (next: boolean | ((value: boolean) => boolean)) => {
    setExpandedRaw((prev) => {
      const value = typeof next === "function" ? next(prev) : next;
      localStorage.setItem(DOCK_EXPANDED_KEY, value ? "1" : "0");
      return value;
    });
  };
  const [tab, setTab] = createSignal<RunTab>("setup");
  // Right-panel density is high, so the dock split is draggable and persisted.
  const [height, setHeight] = createPersistedWidth("terminalDock.height", 280, DOCK_MIN, DOCK_MAX);
  const terms = () => terminalStore.terminals(props.workspace);
  const activeTermId = () => {
    const t = tab();
    return typeof t === "object" ? t.term : null;
  };

  function addTerm() {
    if (terms().length >= MAX_TERMINALS) return;
    const id = terminalStore.addTerminal(props.workspace);
    void send({ type: "spawn_session", workspace: props.workspace, kind: "shell" }).catch(() => {});
    setTab({ term: id });
    setExpanded(true);
  }

  function closeTerm(tabId: string) {
    const sid = terminalStore.sessionId(props.workspace, tabId);
    if (sid != null) void send({ type: "kill_session", session_id: sid }).catch(() => {});
    terminalStore.removeTerminal(props.workspace, tabId);
    if (activeTermId() === tabId) setTab("setup");
  }

  function toggle() {
    setExpanded((e) => !e);
  }

  onMount(() => {
    const onToggle = () => {
      setExpanded((expanded) => !expanded);
      queueMicrotask(() => {
        document.querySelector<HTMLElement>("[data-focus-target='terminal-dock']")?.focus();
      });
    };
    window.addEventListener("archductor:toggle-terminal-dock", onToggle);
    onCleanup(() => window.removeEventListener("archductor:toggle-terminal-dock", onToggle));
  });

  return (
    <div
      class="ws-run-section"
      data-focus-target="terminal-dock"
      tabIndex={-1}
      classList={{ "ws-run-section-expanded": expanded() }}
      style={expanded() ? { height: `${height()}px`, "flex-basis": `${height()}px` } : undefined}
    >
      <Show when={expanded()}>
        <ResizeHandle edge="top" width={height} min={DOCK_MIN} max={DOCK_MAX} onChange={setHeight} />
      </Show>
      <div class="ws-run-tab-bar">
        <Show
          when={expanded()}
          fallback={
            <div class="ws-run-tabs-row ws-run-tabs-row-collapsed">
              <button class="ws-run-tab-btn" title="Open terminal dock" onClick={() => setExpanded(true)}>
                <Icon name="terminal" />
                <span class="sr-only">Terminal dock</span>
              </button>
            </div>
          }
        >
          <div class="ws-run-tabs-row">
            <button
              class="ws-run-tab-btn"
              classList={{ "ws-run-tab-active": tab() === "setup" }}
              title="Setup prompt"
              onClick={() => {
                setTab("setup");
                setExpanded(true);
              }}
            >
              <Icon name="bolt" />
              <span class="sr-only">Setup</span>
            </button>
            <button
              class="ws-run-tab-btn"
              classList={{ "ws-run-tab-active": tab() === "run" }}
              title="Run prompt"
              onClick={() => {
                setTab("run");
                setExpanded(true);
              }}
            >
              <Icon name="play" />
              <span class="sr-only">Run</span>
            </button>
            <For each={terms()}>
              {(t, i) => (
                <div
                  class="ws-run-tab-btn ws-run-terminal-tab"
                  classList={{ "ws-run-tab-active": activeTermId() === t.id }}
                  title={`Terminal ${i() + 1}`}
                  onClick={() => {
                    setTab({ term: t.id });
                    setExpanded(true);
                  }}
                >
                  <span class="ws-run-terminal-tab-label">{i() + 1}</span>
                  <button
                    class="ws-tab-close-button"
                    title="Close terminal"
                    onClick={(e) => {
                      e.stopPropagation();
                      closeTerm(t.id);
                    }}
                  >
                    <Icon name="x" />
                  </button>
                </div>
              )}
            </For>
            <button
              class="ui-button-icon ws-run-add"
              title="New terminal"
              disabled={terms().length >= MAX_TERMINALS}
              onClick={addTerm}
            >
              <Icon name="plus" />
            </button>
          </div>
        </Show>
        <button class="ws-run-collapse-btn" title={expanded() ? "Collapse" : "Expand"} onClick={toggle}>
          <Icon name={expanded() ? "chevron-down" : "chevron-up"} />
        </button>
      </div>
      <Show when={expanded()}>
        <div class="ws-run-body">
          <Switch>
            <Match when={tab() === "setup"}>
              <PromptTab workspace={props.workspace} kind="setup" />
            </Match>
            <Match when={tab() === "run"}>
              <PromptTab workspace={props.workspace} kind="run" />
            </Match>
            <Match when={activeTermId() != null}>
              {/* Keep every terminal mounted so xterm buffers/sessions survive tab
                  switches; only the active pane is shown. */}
              <For each={terms()}>
                {(t) => (
                  <div class="ws-term-pane" classList={{ "ws-term-pane-hidden": activeTermId() !== t.id }}>
                    <TerminalPanel workspace={props.workspace} tabId={t.id} />
                  </div>
                )}
              </For>
            </Match>
          </Switch>
        </div>
      </Show>
    </div>
  );
}
