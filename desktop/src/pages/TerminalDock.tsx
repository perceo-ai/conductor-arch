import { For, Match, Show, Switch, createResource, createSignal } from "solid-js";
import { send } from "@/bridge/client";
import { terminalStore, nav, threadsStore, toastsStore } from "@/store";
import TerminalPanel from "./TerminalPanel";
import type { ArchcarRunScript } from "@/bridge/protocol";
import { runScriptAvailabilityLabel, runScriptStatusText } from "@/lib/runScripts";
import { ProcessesPanel } from "./WorkspaceTabs";
import ResizeHandle from "@/components/ResizeHandle";
import { createPersistedWidth } from "@/lib/persistedWidth";

// Right-panel bottom region — port of the GTK run console (ws_run_console). A
// collapsible dock whose tab strip holds two prompt tabs (Setup, Run) plus any
// number of PTY-backed terminals. Setup/Run show the generated "build this
// script" prompt and queue it into the active chat; terminals are spawned lazily
// so an unopened workspace never starts a process.

const MAX_TERMINALS = 6;
const DOCK_MIN = 120;
const DOCK_MAX = 700;

// Active tab is either a prompt/processes tab or a specific terminal id.
type RunTab = "setup" | "run" | "processes" | { term: string };

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

  return (
    <div class="ws-run-panel">
      <div class="detail-label">{heading()}</div>
      <Show when={props.kind === "run"}>
        <RunScriptsList workspace={props.workspace} />
      </Show>
      <pre class="ws-run-prompt">{prompt.loading ? "Loading…" : prompt()}</pre>
      <div class="ws-run-prompt-actions">
        <span class="ws-run-modal-title">{modalTitle()}</span>
        <button class="ui-button-secondary" onClick={() => void startScript()} disabled={starting()}>
          {starting() ? "Starting…" : startLabel()}
        </button>
        <Show when={props.kind === "run"}>
          <button class="ui-button-secondary" onClick={() => void stopRun()} disabled={stopping()}>
            {stopping() ? "Stopping…" : "Stop Run"}
          </button>
        </Show>
        <button class="suggested-action" onClick={queueDraft} disabled={!(prompt() ?? "").trim()}>
          {buttonLabel()}
        </button>
      </div>
    </div>
  );
}

export default function TerminalDock(props: { workspace: string }) {
  // Expanded by default so the run console is visible (matches GTK). Terminals
  // are still spawned lazily; the Setup tab is the default landing tab.
  const [expanded, setExpanded] = createSignal(true);
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

  return (
    <div
      class="ws-run-section"
      classList={{ "ws-run-section-expanded": expanded() }}
      style={expanded() ? { height: `${height()}px`, "flex-basis": `${height()}px` } : undefined}
    >
      <Show when={expanded()}>
        <ResizeHandle edge="top" width={height} min={DOCK_MIN} max={DOCK_MAX} onChange={setHeight} />
      </Show>
      <div class="ws-run-tab-bar">
        <div class="ws-run-tabs-row">
          <button
            class="ws-run-tab-btn"
            classList={{ "ws-run-tab-active": tab() === "setup" }}
            onClick={() => {
              setTab("setup");
              setExpanded(true);
            }}
          >
            Setup
          </button>
          <button
            class="ws-run-tab-btn"
            classList={{ "ws-run-tab-active": tab() === "run" }}
            onClick={() => {
              setTab("run");
              setExpanded(true);
            }}
          >
            Run
          </button>
          <button
            class="ws-run-tab-btn"
            classList={{ "ws-run-tab-active": tab() === "processes" }}
            onClick={() => {
              setTab("processes");
              setExpanded(true);
            }}
          >
            Processes
          </button>
          <For each={terms()}>
            {(t, i) => (
              <div
                class="ws-run-tab-btn ws-run-terminal-tab"
                classList={{ "ws-run-tab-active": activeTermId() === t.id }}
                onClick={() => {
                  setTab({ term: t.id });
                  setExpanded(true);
                }}
              >
                <span class="ws-run-terminal-tab-label">Terminal {i() + 1}</span>
                <button
                  class="ws-tab-close-button"
                  title="Close terminal"
                  onClick={(e) => {
                    e.stopPropagation();
                    closeTerm(t.id);
                  }}
                >
                  ×
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
            +
          </button>
        </div>
        <button class="ws-run-collapse-btn" title={expanded() ? "Collapse" : "Expand"} onClick={toggle}>
          {expanded() ? "▾" : "▴"}
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
            <Match when={tab() === "processes"}>
              <ProcessesPanel workspace={props.workspace} />
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
