// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSignal } from "solid-js";
import { render } from "solid-js/web";

type Row = { prNumber?: number | null; prState?: string | null; additions?: number; deletions?: number };
const [row, setRow] = createSignal<Row | undefined>({ additions: 0, deletions: 0 });

const send = vi.fn(async (request: { type: string }) => {
  if (request.type === "get_checks_summary") return { type: "error", message: "none" };
  if (request.type === "refresh_pull_request") return { type: "ack" };
  throw new Error(`Unexpected request: ${request.type}`);
});

vi.mock("@/bridge/client", () => ({ send, openExternal: vi.fn() }));
vi.mock("@/store", () => ({
  nav: {},
  threadsStore: { list: () => [], refresh: async () => [] },
  toastsStore: { push: vi.fn() },
  workspacesStore: { row: () => row() },
}));

const { default: WorkspacePrBar } = await import("./WorkspacePrBar");

let dispose: (() => void) | undefined;

afterEach(() => {
  dispose?.();
  dispose = undefined;
  document.body.innerHTML = "";
  send.mockClear();
});

const refreshes = () => send.mock.calls.filter(([request]) => request.type === "refresh_pull_request").length;

describe("WorkspacePrBar", () => {
  it("re-reads a PR from GitHub as soon as it appears, not on the next minute tick", async () => {
    setRow({ additions: 0, deletions: 0 });
    const host = document.createElement("div");
    document.body.append(host);
    dispose = render(() => <WorkspacePrBar workspace="demo" />, host);

    // No PR and no changes yet: nothing to sync.
    await Promise.resolve();
    expect(refreshes()).toBe(0);

    setRow({ prNumber: 152, prState: "open", additions: 3, deletions: 1 });

    await vi.waitFor(() => expect(refreshes()).toBe(1));

    // The agent's next edits update the row; that is not a reason to ask
    // GitHub again (the minute poll covers an open PR).
    setRow({ prNumber: 152, prState: "open", additions: 8, deletions: 1 });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(refreshes()).toBe(1);
  });

  it("looks for a PR as soon as a clean workspace gains changes", async () => {
    setRow({ additions: 0, deletions: 0 });
    const host = document.createElement("div");
    document.body.append(host);
    dispose = render(() => <WorkspacePrBar workspace="demo" />, host);

    await Promise.resolve();
    expect(refreshes()).toBe(0);

    // The branch now has work; a PR may have been opened outside the app.
    setRow({ additions: 5, deletions: 2 });
    await vi.waitFor(() => expect(refreshes()).toBe(1));

    // More edits are not a new reason to ask.
    setRow({ additions: 9, deletions: 2 });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(refreshes()).toBe(1);
  });
});
