// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Covers the state-changing actions: each sends the right archcar request,
// re-pulls the inventory on success (archcar has no inventory-changed event),
// and surfaces an error response as a thrown error.

interface MockApi {
  request: ReturnType<typeof vi.fn>;
  requestLocal: ReturnType<typeof vi.fn>;
  ensureEvents: ReturnType<typeof vi.fn>;
  onEvent: ReturnType<typeof vi.fn>;
  onWindowFocus: ReturnType<typeof vi.fn>;
  window: { minimize: () => void; toggleMaximize: () => void; close: () => void };
  log: ReturnType<typeof vi.fn>;
}

let api: MockApi;

function response(payload: unknown) {
  return payload as never;
}

beforeEach(() => {
  vi.resetModules();
  api = {
    request: vi.fn(async () => response({ type: "workspaces", workspaces: [] })),
    requestLocal: vi.fn(async () => response({ type: "ack" })),
    ensureEvents: vi.fn(async () => ({ ok: true })),
    onEvent: vi.fn(() => () => {}),
    onWindowFocus: vi.fn(() => () => {}),
    window: { minimize: () => {}, toggleMaximize: () => {}, close: () => {} },
    log: vi.fn(),
  };
  (globalThis as unknown as { window: { archductor: MockApi } }).window = { archductor: api };
});

afterEach(() => {
  delete (globalThis as { window?: unknown }).window;
});

/** Route requests by type: return `map[type]`, defaulting to a list response. */
function routeByType(map: Record<string, unknown>) {
  api.request.mockImplementation(async (req: { type: string }) => {
    if (map[req.type]) return response(map[req.type]);
    if (req.type === "list_workspaces") return response({ type: "workspaces", workspaces: [] });
    if (req.type === "list_repositories") return response({ type: "repositories", repositories: [] });
    return response({ type: "ack" });
  });
}

describe("actions.addRepository", () => {
  it("sends add_repository and refreshes inventory", async () => {
    routeByType({ add_repository: { type: "repository_added", name: "demo" } });
    const { actions } = await import("./actions");
    const name = await actions.addRepository({ path: "/tmp/demo", name: "demo" });
    expect(name).toBe("demo");

    const types = api.request.mock.calls.map((c) => (c[0] as { type: string }).type);
    expect(types).toContain("add_repository");
    expect(types).toContain("list_workspaces");
    expect(types).toContain("list_repositories");
  });

  it("throws on an error response", async () => {
    routeByType({ add_repository: { type: "error", message: "not a git repo" } });
    const { actions } = await import("./actions");
    await expect(actions.addRepository({ path: "/tmp/x" })).rejects.toThrow("not a git repo");
  });
});

describe("actions.createWorkspace", () => {
  it("sends create_workspace with the right fields", async () => {
    routeByType({ create_workspace: { type: "workspace_created", name: "berlin" } });
    const { actions } = await import("./actions");
    await actions.createWorkspace({ repository: "demo", name: "berlin", branch: "lc/berlin", baseRef: "main" });

    const call = api.request.mock.calls
      .map((c) => c[0] as Record<string, unknown>)
      .find((p) => p.type === "create_workspace");
    expect(call).toMatchObject({
      type: "create_workspace",
      repository: "demo",
      name: "berlin",
      branch: "lc/berlin",
      base_ref: "main",
    });
  });

  it("sends create_workspace_from_linear with the issue id", async () => {
    routeByType({ create_workspace_from_linear: { type: "workspace_created", name: "arc-123" } });
    const { actions } = await import("./actions");
    await actions.createWorkspaceFromLinear({ repository: "demo", issueId: "ARC-123" });

    const call = api.request.mock.calls
      .map((c) => c[0] as Record<string, unknown>)
      .find((p) => p.type === "create_workspace_from_linear");
    expect(call).toMatchObject({
      type: "create_workspace_from_linear",
      repository: "demo",
      issue_id: "ARC-123",
    });
  });
});

describe("actions.deleteWorkspace", () => {
  it("removes the worktree and deletes the branch only when asked", async () => {
    routeByType({ delete_workspace: { type: "workspace_removed", name: "berlin" } });
    const { actions } = await import("./actions");
    await actions.deleteWorkspace("berlin");
    await actions.deleteWorkspace("berlin", true);

    const calls = api.request.mock.calls
      .map((c) => c[0] as Record<string, unknown>)
      .filter((p) => p.type === "delete_workspace");
    expect(calls[0]).toMatchObject({
      workspace: "berlin",
      keep_worktree: false,
      delete_branch: false,
    });
    expect(calls[1]).toMatchObject({ keep_worktree: false, delete_branch: true });
  });
});

describe("actions.archiveWorkspace", () => {
  it("only hides the workspace; it never asks to remove the worktree", async () => {
    routeByType({ archive_workspace: { type: "workspace_updated", name: "berlin" } });
    const { actions } = await import("./actions");
    await actions.archiveWorkspace("berlin");

    const call = api.request.mock.calls
      .map((c) => c[0] as Record<string, unknown>)
      .find((p) => p.type === "archive_workspace");
    expect(call).toEqual({ type: "archive_workspace", workspace: "berlin" });
  });
});

describe("actions.importWorkspaceFromRemote", () => {
  const remoteWorkspace = {
    name: "parser",
    repository_name: "app",
    branch: "lc/parser",
    base_ref: "main",
  };

  function routeRemote() {
    api.request.mockImplementation(async (req: { type: string }) => {
      if (req.type === "list_workspaces")
        return response({ type: "workspaces", workspaces: [remoteWorkspace] });
      if (req.type === "list_repositories")
        return response({
          type: "repositories",
          repositories: [{ name: "app", remote_url: "git@github.com:me/app.git" }],
        });
      if (req.type === "get_chat_transcript")
        return response({
          type: "chat_transcript",
          thread_id: 1,
          title: "Parser port",
          messages: [{ role: "user", content: "port it", created_at: "1" }],
        });
      return response({ type: "ack" });
    });
  }

  it("reads from the remote but writes to the local daemon", async () => {
    // The whole point of the action: using `send` for the write would recreate
    // the workspace on the machine it came from.
    routeRemote();
    api.requestLocal.mockResolvedValue(
      response({
        type: "workspace_imported",
        workspace: "parser",
        repository: "app-local",
        branch: "lc/parser",
        thread_id: 4,
        copied_messages: 1,
      }),
    );
    const { actions } = await import("./actions");

    const result = await actions.importWorkspaceFromRemote({ workspace: "parser", threadId: 1 });

    expect(result).toEqual({ workspace: "parser", threadId: 4 });
    // Reads went to the selected daemon...
    const readTypes = api.request.mock.calls.map((c) => (c[0] as { type: string }).type);
    expect(readTypes).toEqual(
      expect.arrayContaining(["list_workspaces", "list_repositories", "get_chat_transcript"]),
    );
    expect(readTypes).not.toContain("import_workspace_from_remote");
    // ...and the single write went to this machine.
    expect(api.requestLocal).toHaveBeenCalledTimes(1);
    expect(api.requestLocal.mock.calls[0][0]).toMatchObject({
      type: "import_workspace_from_remote",
      repository_url: "git@github.com:me/app.git",
      branch: "lc/parser",
      chat_title: "Parser port",
    });
  });

  it("imports no chat when no thread is named", async () => {
    routeRemote();
    api.requestLocal.mockResolvedValue(
      response({
        type: "workspace_imported",
        workspace: "parser",
        repository: "app-local",
        branch: "lc/parser",
        copied_messages: 0,
      }),
    );
    const { actions } = await import("./actions");

    await actions.importWorkspaceFromRemote({ workspace: "parser" });

    const readTypes = api.request.mock.calls.map((c) => (c[0] as { type: string }).type);
    expect(readTypes).not.toContain("get_chat_transcript");
    expect(api.requestLocal.mock.calls[0][0]).toMatchObject({ transcript: [] });
  });

  it("refuses a workspace the connected daemon does not have", async () => {
    routeRemote();
    const { actions } = await import("./actions");
    await expect(
      actions.importWorkspaceFromRemote({ workspace: "nope" }),
    ).rejects.toThrow("not a workspace on the connected daemon");
    expect(api.requestLocal).not.toHaveBeenCalled();
  });

  it("pushes the source branch before the local write and starts from it", async () => {
    routeRemote();
    const order: string[] = [];
    api.request.mockImplementation(async (req: { type: string }) => {
      order.push(`remote:${req.type}`);
      if (req.type === "list_workspaces")
        return response({ type: "workspaces", workspaces: [remoteWorkspace] });
      if (req.type === "list_repositories")
        return response({
          type: "repositories",
          repositories: [{ name: "app", remote_url: "git@github.com:me/app.git" }],
        });
      if (req.type === "get_workspace_changes")
        return response({ type: "workspace_changes", workspace: "parser", scope: "uncommitted", files: [] });
      if (req.type === "get_recent_commits")
        return response({ type: "recent_commits", workspace: "parser", log: "4ed0c0e (HEAD -> lc/parser) port it" });
      return response({ type: "workspace_updated", name: "parser" });
    });
    api.requestLocal.mockImplementation(async (req: { type: string }) => {
      order.push(`local:${req.type}`);
      return response({ type: "workspace_imported", workspace: "parser", repository: "app", branch: "lc/parser", copied_messages: 0 });
    });
    const { actions } = await import("./actions");

    await actions.importWorkspaceFromRemote({ workspace: "parser" });

    expect(order.indexOf("remote:push_branch")).toBeGreaterThan(-1);
    expect(order.indexOf("remote:push_branch")).toBeLessThan(
      order.indexOf("local:import_workspace_from_remote"),
    );
    expect(api.request.mock.calls.find((c) => c[0].type === "push_branch")?.[0]).toMatchObject({
      workspace: "parser",
    });
    expect(api.requestLocal.mock.calls[0][0]).toMatchObject({
      source_branch: "lc/parser",
      // The pushed commit, so this machine refuses any other tip.
      source_commit: "4ed0c0e",
      base_ref: "main",
    });
  });

  it("refuses a source with uncommitted changes and pushes nothing", async () => {
    api.request.mockImplementation(async (req: { type: string }) => {
      if (req.type === "list_workspaces")
        return response({ type: "workspaces", workspaces: [remoteWorkspace] });
      if (req.type === "list_repositories")
        return response({
          type: "repositories",
          repositories: [{ name: "app", remote_url: "git@github.com:me/app.git" }],
        });
      if (req.type === "get_workspace_changes")
        return response({
          type: "workspace_changes",
          workspace: "parser",
          scope: "uncommitted",
          files: [{ path: "wip.txt", staged: false, unstaged: false, untracked: true }],
        });
      return response({ type: "ack" });
    });
    const { actions } = await import("./actions");

    await expect(actions.importWorkspaceFromRemote({ workspace: "parser" })).rejects.toThrow(
      "1 uncommitted file(s) on the remote: wip.txt",
    );
    const types = api.request.mock.calls.map((c) => (c[0] as { type: string }).type);
    expect(types).not.toContain("push_branch");
    expect(api.requestLocal).not.toHaveBeenCalled();
  });

  it("carries the most recently active open chat when asked for the latest", async () => {
    routeRemote();
    const base = api.request.getMockImplementation()!;
    api.request.mockImplementation(async (req: { type: string }) => {
      if (req.type === "list_chat_threads")
        return response({
          type: "chat_threads",
          workspace: "parser",
          threads: [
            { id: 1, provider: "claude", title: "old", status: "idle", updated_at: "100" },
            { id: 2, provider: "claude", title: "closed", status: "idle", updated_at: "300", archived_at: "301" },
            { id: 3, provider: "claude", title: "newest", status: "idle", updated_at: "200" },
          ],
        });
      return base(req);
    });
    api.requestLocal.mockResolvedValue(
      response({ type: "workspace_imported", workspace: "parser", repository: "app", branch: "lc/parser", thread_id: 9, copied_messages: 1 }),
    );
    const { actions } = await import("./actions");

    await actions.importWorkspaceFromRemote({ workspace: "parser", threadId: "latest" });

    expect(api.request.mock.calls.find((c) => c[0].type === "get_chat_transcript")?.[0]).toMatchObject({
      thread_id: 3,
    });
    // It keeps talking to the same agent rather than the daemon's default.
    expect(api.requestLocal.mock.calls[0][0]).toMatchObject({ provider: "claude" });
  });

  it("names the missing clone, then clones on this machine before importing", async () => {
    routeRemote();
    api.requestLocal.mockResolvedValueOnce(
      response({
        type: "error",
        message: "no repository here has remote git@github.com:me/app.git — rerun with `--clone-into <dir>`",
      }),
    );
    const { actions, MissingLocalRepositoryError } = await import("./actions");

    const err = await actions.importWorkspaceFromRemote({ workspace: "parser" }).catch((e) => e);
    expect(err).toBeInstanceOf(MissingLocalRepositoryError);
    expect(err).toMatchObject({ repositoryUrl: "git@github.com:me/app.git", repositoryName: "app" });

    api.requestLocal.mockReset();
    api.requestLocal.mockImplementation(async (req: { type: string }) =>
      req.type === "clone_repository"
        ? response({ type: "repository_added", name: "app" })
        : response({ type: "workspace_imported", workspace: "parser", repository: "app", branch: "lc/parser", copied_messages: 0 }),
    );
    await actions.importWorkspaceFromRemote({ workspace: "parser", cloneInto: "/Users/me/src/app" });
    const localTypes = api.requestLocal.mock.calls.map((c) => (c[0] as { type: string }).type);
    expect(localTypes).toEqual(["clone_repository", "import_workspace_from_remote"]);
    expect(api.requestLocal.mock.calls[0][0]).toMatchObject({
      url: "git@github.com:me/app.git",
      dest: "/Users/me/src/app",
    });
  });

  it("stops when the remote repository has no URL to match on", async () => {
    api.request.mockImplementation(async (req: { type: string }) => {
      if (req.type === "list_workspaces")
        return response({ type: "workspaces", workspaces: [remoteWorkspace] });
      if (req.type === "list_repositories")
        return response({ type: "repositories", repositories: [{ name: "app" }] });
      return response({ type: "ack" });
    });
    const { actions } = await import("./actions");
    await expect(
      actions.importWorkspaceFromRemote({ workspace: "parser" }),
    ).rejects.toThrow("no remote URL");
    expect(api.requestLocal).not.toHaveBeenCalled();
  });
});

describe("actions.updateDaemon", () => {
  const status = (current: string) => ({
    type: "update_status",
    status: {
      current_version: current,
      latest_version: "0.8.3",
      update_available: current !== "0.8.3",
      channel: "tarball",
      binary_path: "/srv/bin/archcar",
      restart_pending: false,
      can_self_update: true,
      auto_update: false,
    },
  });

  it("applies, rides out the restart, and returns once the new version answers", async () => {
    let calls = 0;
    api.request.mockImplementation(async (req: { type: string }) => {
      if (req.type === "apply_update")
        return response({
          type: "update_applied",
          update: { from_version: "0.8.2", to_version: "0.8.3", downloaded: true },
        });
      if (req.type === "get_update_status") {
        calls += 1;
        // First poll: the daemon is mid-restart. Second: still the old one.
        if (calls === 1) throw new Error("connect ECONNREFUSED");
        return response(status(calls === 2 ? "0.8.2" : "0.8.3"));
      }
      return response({ type: "workspaces", workspaces: [] });
    });
    const { actions } = await import("./actions");

    const update = await actions.updateDaemon({ pollMs: 1, timeoutMs: 1000 });

    expect(update.to_version).toBe("0.8.3");
    expect(calls).toBe(3);
  });

  it("surfaces the daemon's refusal (agents mid-turn) as an error", async () => {
    routeByType({
      apply_update: { type: "error", message: "agents are mid-turn in berlin" },
    });
    const { actions } = await import("./actions");
    await expect(actions.updateDaemon({ pollMs: 1 })).rejects.toThrow("mid-turn in berlin");
  });

  it("stops polling once the user switches to another daemon", async () => {
    api.request.mockImplementation(async (req: { type: string }) =>
      req.type === "apply_update"
        ? response({
            type: "update_applied",
            update: { from_version: "0.8.2", to_version: "0.8.3", downloaded: true },
          })
        : response(status("0.8.2")),
    );
    const { actions } = await import("./actions");
    await expect(
      actions.updateDaemon({ pollMs: 1, timeoutMs: 1000, stillTargeted: () => false }),
    ).rejects.toThrow("switched daemons");
  });

  it("fails loudly when the daemon never comes back on the new version", async () => {
    api.request.mockImplementation(async (req: { type: string }) =>
      req.type === "apply_update"
        ? response({
            type: "update_applied",
            update: { from_version: "0.8.2", to_version: "0.8.3", downloaded: true },
          })
        : response(status("0.8.2")),
    );
    const { actions } = await import("./actions");
    await expect(actions.updateDaemon({ pollMs: 1, timeoutMs: 20 })).rejects.toThrow(
      "did not come back on v0.8.3",
    );
  });
});

describe("actions.finishBundledDaemonUpdate", () => {
  function daemon(overrides: Record<string, unknown>) {
    return {
      type: "update_status",
      status: {
        current_version: "0.8.2",
        update_available: false,
        channel: "desktop_app",
        binary_path: "/Applications/archductor-desktop.app/Contents/Resources/bin/archcar",
        restart_pending: false,
        can_self_update: false,
        auto_update: false,
        ...overrides,
      },
    };
  }

  it("restarts this machine's bundled daemon even while a remote client is selected", async () => {
    let applied = false;
    api.requestLocal.mockImplementation(async (req: { type: string }) => {
      if (req.type === "apply_update") {
        applied = true;
        return response({
          type: "update_applied",
          update: { from_version: "0.8.2", to_version: "0.8.3", downloaded: false },
        });
      }
      if (req.type === "get_update_status")
        return response(
          applied
            ? daemon({ current_version: "0.8.3" })
            : daemon({ restart_pending: true, on_disk_version: "0.8.3" }),
        );
      return response({ type: "workspaces", workspaces: [] });
    });
    const { actions } = await import("./actions");
    await expect(actions.finishBundledDaemonUpdate(1)).resolves.toBe(true);
    expect(applied).toBe(true);
    // Nothing went to the selected (possibly remote) daemon.
    const remoteTypes = api.request.mock.calls.map((c) => (c[0] as { type: string }).type);
    expect(remoteTypes).not.toContain("apply_update");
  });

  it("leaves other channels and daemons without the RPC alone", async () => {
    const { actions } = await import("./actions");
    api.requestLocal.mockResolvedValue(response(daemon({ channel: "tarball", restart_pending: true })));
    await expect(actions.finishBundledDaemonUpdate(1)).resolves.toBe(false);

    api.requestLocal.mockRejectedValue(new Error("empty response from archcar sidecar"));
    await expect(actions.finishBundledDaemonUpdate(1)).resolves.toBe(false);
    const types = api.requestLocal.mock.calls.map((c) => (c[0] as { type: string }).type);
    expect(types).not.toContain("apply_update");
  });
});
