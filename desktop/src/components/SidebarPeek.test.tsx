// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { render } from "solid-js/web";

import type { RepositoryRow } from "@/store/repositories";
import type { WorkspaceRow } from "@/store/workspaces";
import { RepositoryPeek, WorkspacePeek } from "./SidebarPeek";

let dispose: (() => void) | undefined;

function textFor(view: () => unknown) {
  const host = document.createElement("div");
  document.body.append(host);
  dispose = render(view as never, host);
  return host.textContent ?? "";
}

afterEach(() => {
  dispose?.();
  dispose = undefined;
  document.body.innerHTML = "";
});

describe("sidebar Peek content", () => {
  it("summarizes live workspace state without opening it", () => {
    const row: WorkspaceRow = {
      id: 7,
      name: "peek-actions",
      path: "/tmp/project/peek-actions",
      branch: "feature/peek-actions",
      baseRef: "main",
      status: "active",
      repository: "archductor",
      additions: 14,
      deletions: 3,
      openTodos: 2,
      openTasks: 4,
      blockedTasks: 1,
      activeSessions: 2,
      awaitingInput: true,
      runRunning: false,
      changedFiles: 2,
      prNumber: 108,
      prState: "open",
      updatedAt: "2026-08-24T20:00:00Z",
    };

    const text = textFor(() => <WorkspacePeek row={row} />);

    expect(text).toContain("feature/peek-actions");
    expect(text).toContain("Needs input");
    expect(text).toContain("2 changed files");
    expect(text).toContain("+14");
    expect(text).toContain("−3");
    expect(text).toContain("2 agents");
    expect(text).toContain("1 blocked task");
    expect(text).toContain("PR #108");
  });

  it("summarizes repository identity and workspace counts", () => {
    const row: RepositoryRow = {
      id: 3,
      name: "archductor",
      rootPath: "/Users/demo/code/archductor",
      defaultBranch: "main",
      remoteName: "origin",
      activeWorkspaces: 2,
      totalWorkspaces: 4,
    };

    const text = textFor(() => <RepositoryPeek row={row} />);

    expect(text).toContain("main");
    expect(text).toContain("2 active");
    expect(text).toContain("4 total");
    expect(text).toContain("origin");
    expect(text).toContain("/Users/demo/code/archductor");
  });
});
