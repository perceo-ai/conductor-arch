// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "solid-js/web";

const send = vi.fn();
vi.mock("@/bridge/client", () => ({
  send: (...args: unknown[]) => send(...args),
  openExternal: vi.fn(),
}));

import { SummaryPanel } from "./WorkspaceIntel";
import { intelStore } from "@/store/intel";

/**
 * The Summary tab's resources re-key on `intelStore.version()`, which archcar
 * bumps on every `summary_updated` / `task_updated`. Reading the resource
 * directly made the panel blank and redraw on each of those — a flash on a
 * reading surface. These tests pin both halves of the fix: hold the last
 * answer through a refetch, but never show another workspace's answer.
 */

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function summaryFor(workspace: string) {
  return {
    type: "summaries",
    summaries: [
      {
        scope_type: "workspace",
        body_markdown: `Summary of ${workspace}`,
        source_refs: ["archductor:agent"],
        updated_at: "1",
      },
    ],
  };
}

function reply(payload: { type: string; workspace?: string }) {
  switch (payload.type) {
    case "list_summaries":
      return summaryFor(payload.workspace ?? "");
    case "list_tasks":
      return { type: "tasks", tasks: [] };
    case "list_todos":
      return { type: "todos", todos: [] };
    case "list_session_overlaps":
      return { type: "session_overlaps", overlaps: [] };
    default:
      return { type: "error", message: `unexpected ${payload.type}` };
  }
}

afterEach(() => {
  send.mockReset();
  document.body.innerHTML = "";
});

describe("SummaryPanel", () => {
  it("holds the summary on screen while an intel event refetches it", async () => {
    send.mockImplementation(async (payload) => reply(payload));
    const host = document.createElement("div");
    document.body.append(host);
    const dispose = render(() => <SummaryPanel workspace="alpha" />, host);
    await flush();
    expect(host.textContent).toContain("Summary of alpha");

    const pending: Array<() => void> = [];
    send.mockImplementation(
      (payload) =>
        new Promise((resolve) => pending.push(() => resolve(reply(payload)))),
    );
    intelStore.refreshWorkspaceIntel("alpha");
    await flush();
    expect(host.textContent).toContain("Summary of alpha");
    expect(host.textContent).not.toContain("Loading…");

    for (const settle of pending) settle();
    await flush();
    expect(host.textContent).toContain("Summary of alpha");

    dispose();
  });

  it("does not show one workspace's summary under another's name", async () => {
    send.mockImplementation(async (payload) => reply(payload));
    const [workspace, setWorkspace] = await import("solid-js").then(({ createSignal }) =>
      createSignal("alpha"),
    );
    const host = document.createElement("div");
    document.body.append(host);
    const dispose = render(() => <SummaryPanel workspace={workspace()} />, host);
    await flush();
    expect(host.textContent).toContain("Summary of alpha");

    send.mockImplementation(() => new Promise(() => {}));
    setWorkspace("beta");
    await flush();
    expect(host.textContent).not.toContain("Summary of alpha");
    expect(host.textContent).toContain("Loading…");

    dispose();
  });
});
