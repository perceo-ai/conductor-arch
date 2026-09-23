// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "solid-js/web";
import { Suspense } from "solid-js";

// The Summary panel refetches its resources when archcar broadcasts
// summary_updated / task_updated — which is after nearly every agent turn.
// These tests pin the repaint behaviour: an update must revise the panel in
// place, not blank it to "Loading…" and re-enter, which read as the whole
// Summary tab flashing every time any agent finished a turn.

let summariesCalls = 0;
let releaseSecondSummaries: (() => void) | undefined;

const send = vi.fn(async (request: { type: string }) => {
  if (request.type === "list_summaries") {
    summariesCalls += 1;
    if (summariesCalls > 1) {
      // Keep the refetch in flight so the test can look at the DOM mid-load.
      await new Promise<void>((resolve) => {
        releaseSecondSummaries = resolve;
      });
    }
    return {
      type: "summaries",
      summaries: [
        {
          id: 1,
          scope_type: "workspace",
          scope_ref: "demo",
          body_markdown: "The demo summary body.",
          source_refs: ["archductor:agent"],
          updated_at: "1790000000",
        },
      ],
    };
  }
  if (request.type === "list_tasks") return { type: "tasks", tasks: [] };
  if (request.type === "list_todos") return { type: "todos", todos: [] };
  if (request.type === "list_session_overlaps") return { type: "session_overlaps", overlaps: [] };
  throw new Error(`Unexpected request: ${request.type}`);
});

vi.mock("@/bridge/client", () => ({ send, openExternal: vi.fn() }));
vi.mock("@/store", () => ({
  actions: {},
  nav: { selectedChatThread: () => null, selectedWorkspace: () => "demo" },
  threadsStore: { list: () => [], refresh: async () => [] },
  toastsStore: { push: vi.fn(), error: vi.fn() },
  workspacesStore: { row: () => undefined, state: { order: [], byName: {} } },
}));

const { SummaryPanel } = await import("./WorkspaceIntel");
const { intelStore } = await import("@/store/intel");

let dispose: (() => void) | undefined;

function mount() {
  const host = document.createElement("div");
  document.body.append(host);
  // The app mounts every panel under <Suspense> (PanelLeaf). Reproducing that
  // matters: a refetch observed by Suspense detaches the whole panel until it
  // resolves, which is the flash this test pins down.
  dispose = render(
    () => (
      <Suspense fallback={<div>suspense-fallback</div>}>
        <SummaryPanel workspace="demo" />
      </Suspense>
    ),
    host,
  );
  return host;
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

afterEach(() => {
  dispose?.();
  dispose = undefined;
  document.body.innerHTML = "";
  releaseSecondSummaries?.();
  releaseSecondSummaries = undefined;
  summariesCalls = 0;
  send.mockClear();
});

describe("SummaryPanel on context updates", () => {
  it("keeps the summary on screen while a context update refetches", async () => {
    const host = mount();
    await flush();
    expect(host.textContent).toContain("The demo summary body.");

    // archcar broadcast summary_updated → the reducer bumps the intel version.
    intelStore.refreshWorkspaceIntel("demo");
    await flush();

    // The refetch is still in flight; the panel must show the last summary,
    // not collapse to the loading fallback.
    expect(summariesCalls).toBe(2);
    expect(host.textContent).toContain("The demo summary body.");
    expect(host.textContent).not.toContain("Loading…");
    expect(host.textContent).not.toContain("suspense-fallback");
  });
});
