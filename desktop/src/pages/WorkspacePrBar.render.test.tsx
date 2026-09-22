// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "solid-js/web";

const send = vi.fn();
vi.mock("@/bridge/client", () => ({
  send: (...args: unknown[]) => send(...args),
  openExternal: vi.fn(),
}));

import WorkspacePrBar from "./WorkspacePrBar";
import { workspacesStore } from "@/store";
import type { WorkspaceRow } from "@/store/workspaces";

/**
 * The bar reads two sources that arrive at different times: the workspace row
 * and the checks summary. Before either lands, an empty input derives the same
 * answer as a genuinely clean workspace — which is how the bar used to assert
 * "No changes" and then visibly flip. These tests pin the honest in-between.
 */

function row(overrides: Partial<WorkspaceRow> = {}): WorkspaceRow {
  return {
    id: 1,
    name: "ws",
    path: "/tmp/ws",
    branch: "feature",
    baseRef: "main",
    status: "active",
    repository: "repo",
    additions: 0,
    deletions: 0,
    openTodos: 0,
    openTasks: 0,
    blockedTasks: 0,
    activeSessions: 0,
    awaitingInput: false,
    runRunning: false,
    changedFiles: 0,
    updatedAt: "1",
    ...overrides,
  };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

afterEach(() => {
  send.mockReset();
  document.body.innerHTML = "";
});

describe("WorkspacePrBar", () => {
  it("says loading until the workspace row has landed", async () => {
    let resolveChecks: (value: unknown) => void = () => {};
    send.mockImplementation(
      () => new Promise((resolve) => (resolveChecks = resolve)),
    );
    workspacesStore.setAll([]);

    const host = document.createElement("div");
    document.body.append(host);
    const dispose = render(() => <WorkspacePrBar workspace="ws" />, host);

    expect(host.textContent).toContain("Loading…");

    workspacesStore.setAll([row({ changedFiles: 2 })]);
    await flush();
    // The row is enough to answer; the still-pending checks call only refines
    // it, so it must not hold the bar in a loading state.
    expect(host.textContent).toContain("No pull request yet");

    resolveChecks({ type: "checks_summary", summary: { check_status: "success" } });
    await flush();
    expect(host.textContent).toContain("No pull request yet");

    dispose();
  });

  it("keeps the last answer on screen while a refetch is in flight", async () => {
    send.mockResolvedValue({
      type: "checks_summary",
      summary: { check_status: "success", branch_ahead: 0, branch_behind: 0 },
    });
    workspacesStore.setAll([row({ prNumber: 7, prState: "open" })]);

    const host = document.createElement("div");
    document.body.append(host);
    const dispose = render(() => <WorkspacePrBar workspace="ws" />, host);
    await flush();
    expect(host.textContent).toContain("Ready to merge");

    // A workspace event bumps updated_at, which re-keys the checks resource.
    // Before `.latest`, that blanked the bar mid-flight.
    let resolveChecks: (value: unknown) => void = () => {};
    send.mockImplementation(
      () => new Promise((resolve) => (resolveChecks = resolve)),
    );
    workspacesStore.patch("ws", { updatedAt: "2" });
    await flush();
    expect(host.textContent).toContain("Ready to merge");
    expect(host.textContent).not.toContain("Loading…");

    resolveChecks({ type: "checks_summary", summary: { check_status: "failure" } });
    await flush();
    expect(host.textContent).toContain("Checks failing");

    dispose();
  });
});
