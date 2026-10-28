// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Covers the state-changing actions: each sends the right archcar request,
// re-pulls the inventory on success (archcar has no inventory-changed event),
// and surfaces an error response as a thrown error.

interface MockApi {
  request: ReturnType<typeof vi.fn>;
  requestLocal: ReturnType<typeof vi.fn>;
  requestClient: ReturnType<typeof vi.fn>;
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
    requestClient: vi.fn(async () => response({ type: "ack" })),
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
      remove_worktree: true,
      delete_branch: false,
    });
    expect(calls[1]).toMatchObject({ remove_worktree: true, delete_branch: true });
  });
});

describe("actions.deleteWorkspace when the inventory refresh fails", () => {
  function routeWithFailingRefresh(deleteResponse: unknown) {
    api.request.mockImplementation(async (req: { type: string }) => {
      if (req.type === "delete_workspace") return response(deleteResponse);
      if (req.type === "list_workspaces" || req.type === "list_repositories") {
        throw new Error("daemon went away");
      }
      return response({ type: "ack" });
    });
  }

  it("still reports a successful delete as a success", async () => {
    routeWithFailingRefresh({ type: "workspace_removed", name: "berlin" });
    const { actions } = await import("./actions");
    await expect(actions.deleteWorkspace("berlin")).resolves.toBeUndefined();
  });

  it("surfaces the delete's own error, not the refresh's", async () => {
    routeWithFailingRefresh({
      type: "error",
      message: "refusing to remove /w/berlin: 1 process(es) still running inside it",
    });
    const { actions } = await import("./actions");
    await expect(actions.deleteWorkspace("berlin")).rejects.toThrow(/refusing to remove/);
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

describe("actions.transferWorkspace", () => {
  const sourceWorkspace = {
    name: "parser",
    repository_name: "app",
    branch: "lc/parser",
    base_ref: "main",
    status: "active",
  };
  const targetWorkspace = { ...sourceWorkspace, repository_name: "app-here" };
  const REPO_URL = "git@github.com:me/app.git";
  const PUSHED = "abc1234";

  /**
   * Both daemons are mocked behind the one client-pinned transport, keyed by
   * the client id the action addresses them with. Nothing in a transfer may go
   * through the switcher-following `request`, so an unkeyed call is a failure
   * rather than a default.
   */
  let order: string[];
  let handlers: Record<string, (req: { type: string }) => unknown>;
  let envIsSource: boolean;

  beforeEach(() => {
    order = [];
    handlers = {};
    envIsSource = false;
    api.requestClient.mockImplementation(async (id: string | null, req: { type: string }) => {
      const key = id ?? "local";
      order.push(`${key}:${req.type}`);
      const handler = handlers[key];
      if (!handler) throw new Error(`no daemon mocked for client ${key}`);
      return response(handler(req));
    });
    // `request` is the switcher-following transport. A transfer may only use it
    // for the environment-pinned daemon (and for the inventory refresh at the
    // end), so it stands in for the source there and is logged distinctly.
    api.request.mockImplementation(async (req: { type: string }) => {
      order.push(`switcher:${req.type}`);
      const handler = handlers.src;
      if (handler && envIsSource) return response(handler(req));
      if (req.type === "list_repositories")
        return response({ type: "repositories", repositories: [] });
      return response({ type: "workspaces", workspaces: [] });
    });
  });

  /** The source: one workspace, one chat, by default one live agent on it. */
  function routeSource(opts: { liveSession?: boolean; transcript?: unknown[] } = {}) {
    const live = opts.liveSession ?? true;
    let killed = false;
    const transcript = opts.transcript ?? [{ role: "user", content: "port it", created_at: "1" }];
    handlers.src = (req) => {
      switch (req.type) {
        case "list_workspaces":
          return { type: "workspaces", workspaces: [sourceWorkspace] };
        case "list_repositories":
          return { type: "repositories", repositories: [{ name: "app", remote_url: REPO_URL }] };
        case "list_chat_threads":
          return {
            type: "chat_threads",
            workspace: "parser",
            threads: [
              { id: 7, provider: "codex", title: "Parser port", status: "open", updated_at: "9" },
            ],
          };
        case "get_chat_snapshot":
          return {
            type: "chat_snapshot",
            snapshot: {
              thread_id: 7,
              messages: [],
              events: [],
              provider_events: [],
              queued_inputs: [],
              live_session:
                live && !killed
                  ? { session_id: 42, status: "running", runtime_state: "running", ready: true }
                  : undefined,
            },
          };
        case "kill_session":
          killed = true;
          return { type: "ack" };
        case "get_session_status":
          return {
            type: "session_status",
            session_id: 42,
            status: killed ? "exited" : "running",
            runtime_state: killed ? "exited" : "running",
            ready: false,
          };
        case "get_chat_transcript":
          return { type: "chat_transcript", thread_id: 7, title: "Parser port", messages: transcript };
        case "get_workspace_changes":
          return { type: "workspace_changes", workspace: "parser", files: [] };
        case "get_recent_commits":
          return { type: "recent_commits", workspace: "parser", log: `${PUSHED} port it` };
        case "get_remote_access":
          return { type: "remote_access", token: "tok-src", token_path: "/src/archcar.token" };
        default:
          return { type: "ack" };
      }
    };
  }

  /**
   * The target. `existing` pre-places a workspace as an earlier attempt would;
   * `status`, `repository`, `head` and `threads` let a test make that workspace
   * archived, from another repository, at another commit, or chatless.
   */
  function routeTarget(
    opts: {
      existing?: boolean;
      status?: string;
      repository?: string;
      head?: string;
      threads?: unknown[];
      delivered?: boolean;
      /** Make the target answer the identity probe as the source does. */
      identity?: string;
      identityPath?: string;
    } = {},
  ) {
    let imported = opts.existing ?? false;
    let delivered = opts.delivered ?? false;
    handlers.dst = (req) => {
      switch (req.type) {
        case "list_workspaces":
          return {
            type: "workspaces",
            workspaces: imported
              ? [
                  {
                    ...targetWorkspace,
                    status: opts.status ?? "active",
                    repository_name: opts.repository ?? "app-here",
                  },
                ]
              : [],
          };
        case "list_repositories":
          return {
            type: "repositories",
            repositories: [{ name: "app-here", remote_url: REPO_URL }],
          };
        case "get_recent_commits":
          return { type: "recent_commits", workspace: "parser", log: `${opts.head ?? PUSHED} x` };
        case "get_remote_access":
          return {
            type: "remote_access",
            token: opts.identity ?? "tok-dst",
            token_path: opts.identityPath ?? "/dst/archcar.token",
          };
        case "import_workspace_from_remote":
          imported = true;
          return {
            type: "workspace_imported",
            workspace: "parser",
            repository: "app-here",
            branch: "lc/parser",
            thread_id: 11,
            copied_messages: 1,
          };
        case "list_chat_threads":
          return {
            type: "chat_threads",
            workspace: "parser",
            threads:
              opts.threads ??
              [{ id: 11, provider: "codex", title: "Parser port", status: "open", updated_at: "9" }],
          };
        case "create_chat_thread":
          return {
            type: "chat_thread_created",
            thread: { id: 12, provider: "codex", title: "Transferred chat", status: "open", updated_at: "9" },
          };
        case "queue_chat_input":
          // Delivery is only observable afterwards, via the thread's messages.
          delivered = true;
          return { type: "queued_chat_input", input: { id: 1, thread_id: 11 } };
        case "get_chat_snapshot":
          return {
            type: "chat_snapshot",
            snapshot: {
              thread_id: 11,
              messages: delivered
                ? [
                    {
                      id: 1,
                      role: "user",
                      source: "user_send",
                      content: `This conversation moved from daemon src to dst; the branch is at ${PUSHED}.`,
                    },
                  ]
                : [],
              events: [],
              provider_events: [],
              queued_inputs: [],
            },
          };
        default:
          return { type: "ack" };
      }
    };
  }

  const input = {
    workspace: "parser",
    toClientId: "dst",
    toLabel: "dst",
    fromLabel: "src",
    fromDaemon: { kind: "client", clientId: "src" } as const,
  };

  it("refuses a live source session without force, and pushes nothing", async () => {
    routeSource();
    routeTarget();
    const { actions, LiveSourceSessionError } = await import("./actions");

    const err = await actions.transferWorkspace(input).catch((e) => e);

    expect(err).toBeInstanceOf(LiveSourceSessionError);
    expect((err as Error).message).toContain("session 42 (codex");
    expect(order).not.toContain("src:push_branch");
    expect(order).not.toContain("src:kill_session");
    expect(order).not.toContain("src:archive_workspace");
  });

  it("stops the source's session before it pushes the branch", async () => {
    routeSource();
    routeTarget();
    const { actions } = await import("./actions");

    await actions.transferWorkspace({ ...input, force: true });

    expect(order.indexOf("src:kill_session")).toBeGreaterThanOrEqual(0);
    expect(order.indexOf("src:kill_session")).toBeLessThan(order.indexOf("src:push_branch"));
    // And the kill was waited on, not fired and forgotten.
    expect(order.indexOf("src:get_session_status")).toBeLessThan(order.indexOf("src:push_branch"));
  });

  it("writes to the named target daemon, never to this machine", async () => {
    // The gap this closes: `importWorkspaceFromRemote` hardcodes the local
    // daemon, so daemon-to-daemon was impossible. Neither end here is local.
    routeSource({ liveSession: false });
    routeTarget();
    const { actions } = await import("./actions");

    const moved = await actions.transferWorkspace(input);

    expect(moved).toEqual({ workspace: "parser" });
    expect(api.requestLocal).not.toHaveBeenCalled();
    const imported = api.requestClient.mock.calls.find(
      (c) => (c[1] as { type: string }).type === "import_workspace_from_remote",
    );
    expect(imported?.[0]).toBe("dst");
    expect(imported?.[1]).toMatchObject({
      repository_url: REPO_URL,
      branch: "lc/parser",
      base_ref: "main",
      source_commit: PUSHED,
      provider: "codex",
    });
  });

  it("hands the target's session the last user message under a transfer preamble", async () => {
    routeSource({ liveSession: false });
    routeTarget();
    const { actions } = await import("./actions");

    await actions.transferWorkspace(input);

    const spawned = api.requestClient.mock.calls.find(
      (c) => (c[1] as { type: string }).type === "ensure_chat_thread_session",
    );
    expect(spawned?.[1]).toMatchObject({ workspace: "parser", thread_id: 11, kind: "codex" });
    const queued = api.requestClient.mock.calls.find(
      (c) => (c[1] as { type: string }).type === "queue_chat_input",
    );
    expect(queued?.[1]).toMatchObject({ thread_id: 11, kind: "user", verbatim: true });
    const text = (queued?.[1] as { input: string }).input;
    expect(text).toContain(`moved from daemon src to dst; the branch is at ${PUSHED}`);
    expect(text).toContain("port it");
  });

  it("archives the source only after the handover is confirmed from the thread", async () => {
    routeSource({ liveSession: false });
    routeTarget();
    const { actions } = await import("./actions");

    await actions.transferWorkspace(input);

    // Confirmed from the target thread's own messages, not from an empty
    // queue: a claimed-but-undelivered row leaves the queue empty too.
    expect(order).not.toContain("dst:list_queued_chat_inputs");
    const archived = order.indexOf("src:archive_workspace");
    const queued = order.indexOf("dst:queue_chat_input");
    expect(queued).toBeGreaterThanOrEqual(0);
    expect(archived).toBeGreaterThan(queued);
    expect(archived).toBeGreaterThan(order.lastIndexOf("dst:get_chat_snapshot"));
  });

  it("leaves the source alone when the target cannot take the workspace", async () => {
    routeSource({ liveSession: false });
    handlers.dst = (req) => {
      if (req.type === "list_workspaces") return { type: "workspaces", workspaces: [] };
      if (req.type === "list_repositories")
        return { type: "repositories", repositories: [{ name: "app-here", remote_url: REPO_URL }] };
      if (req.type === "import_workspace_from_remote")
        return { type: "error", message: "no repository here has remote git@..." };
      return { type: "ack" };
    };
    const { actions, MissingLocalRepositoryError } = await import("./actions");

    const err = await actions.transferWorkspace(input).catch((e) => e);

    expect(err).toBeInstanceOf(MissingLocalRepositoryError);
    expect(order).not.toContain("src:archive_workspace");
  });

  it("adopts a workspace an earlier attempt already left on the target", async () => {
    routeSource({ liveSession: false });
    routeTarget({ existing: true });
    const { actions } = await import("./actions");

    await actions.transferWorkspace(input);

    expect(order).not.toContain("dst:import_workspace_from_remote");
  });

  it("does not hand a chat its transfer message twice", async () => {
    routeSource({ liveSession: false });
    routeTarget({ existing: true, delivered: true });
    const { actions } = await import("./actions");

    await actions.transferWorkspace(input);

    expect(order).not.toContain("dst:queue_chat_input");
    expect(order).not.toContain("dst:ensure_chat_thread_session");
  });

  it("clones onto the target daemon, not onto this machine", async () => {
    // The CLI's `--clone-into` clones on the target; the desktop must not send
    // the clone to whichever machine happens to be running the app.
    routeSource({ liveSession: false });
    routeTarget();
    const { actions } = await import("./actions");

    await actions.transferWorkspace({ ...input, cloneInto: "/srv/app" });

    const cloned = api.requestClient.mock.calls.find(
      (c) => (c[1] as { type: string }).type === "clone_repository",
    );
    expect(cloned?.[0]).toBe("dst");
    expect(cloned?.[1]).toMatchObject({ url: REPO_URL, dest: "/srv/app" });
    expect(api.requestLocal).not.toHaveBeenCalled();
    expect(order.indexOf("dst:clone_repository")).toBeLessThan(
      order.indexOf("dst:import_workspace_from_remote"),
    );
  });

  // --- regressions ------------------------------------------------------

  it("refuses when an archived workspace on the target still holds the branch", async () => {
    // Twice wrong before now. First it *adopted* the archived workspace and
    // resumed inside something invisible on the target's board. Then the
    // archived-exclusion fix made it import instead — and because an archived
    // row still holds its branch, the daemon suffixed it: a second worktree on
    // a `-v2` branch with a second agent replaying the same conversation,
    // reported as success. Neither is safe, so it refuses.
    routeSource({ liveSession: false });
    routeTarget({ existing: true, status: "archived" });
    const { actions } = await import("./actions");

    const err = await actions.transferWorkspace(input).catch((e) => e);

    expect((err as Error).message).toContain("is archived but still holds branch");
    expect(order).not.toContain("dst:import_workspace_from_remote");
    expect(order).not.toContain("dst:queue_chat_input");
    expect(order).not.toContain("src:archive_workspace");
  });

  it("hands over to the imported chat, not whichever is newest", async () => {
    // Adoption proves the workspace is ours, not which chat in it is the
    // imported one. An operator's own chat, opened after an interrupted
    // transfer and therefore newest, used to receive the handover.
    routeSource({ liveSession: false });
    routeTarget({ existing: true });
    const base = handlers.dst;
    let handedOver = false;
    handlers.dst = (req: { type: string; thread_id?: number }) => {
      if (req.type === "queue_chat_input") handedOver = true;
      if (req.type === "list_chat_threads") {
        return {
          type: "chat_threads",
          workspace: "parser",
          threads: [
            // Newest first, and it is the operator's own empty chat.
            { id: 99, provider: "codex", title: "My notes", status: "open", updated_at: "99" },
            { id: 11, provider: "codex", title: "Parser port", status: "open", updated_at: "9" },
          ],
        };
      }
      if (req.type === "get_chat_snapshot") {
        const seeded = req.thread_id === 11;
        const messages: unknown[] = seeded
          ? [{ id: 1, role: "user", source: "fork", content: "port it" }]
          : [];
        // Only the imported chat ever receives the handover, and only once the
        // queue has taken it — which is what the confirmation poll waits for.
        if (seeded && handedOver) {
          messages.push({
            id: 2,
            role: "user",
            source: "user_send",
            content: `This conversation moved from daemon src to dst; the branch is at ${PUSHED}.`,
          });
        }
        return {
          type: "chat_snapshot",
          snapshot: {
            thread_id: req.thread_id,
            messages,
            events: [],
            provider_events: [],
            queued_inputs: [],
          },
        };
      }
      return base(req);
    };
    const { actions } = await import("./actions");

    await actions.transferWorkspace(input);

    const spawned = api.requestClient.mock.calls.find(
      (c) => (c[1] as { type: string }).type === "ensure_chat_thread_session",
    );
    expect(spawned?.[1]).toMatchObject({ thread_id: 11 });
    const queued = api.requestClient.mock.calls.find(
      (c) => (c[1] as { type: string }).type === "queue_chat_input",
    );
    expect(queued?.[1]).toMatchObject({ thread_id: 11 });
  });

  it("does not adopt a same-named workspace from another repository", async () => {
    routeSource({ liveSession: false });
    routeTarget({ existing: true, repository: "something-else" });
    const { actions } = await import("./actions");

    await actions.transferWorkspace(input);

    expect(order).toContain("dst:import_workspace_from_remote");
  });

  it("imports around a same-named workspace that is on another branch", async () => {
    // A name collision, not an earlier attempt: the target has a `parser`
    // workspace but on a different branch and at a different commit. The
    // import renames around it, which duplicates nothing. (A workspace on *our*
    // branch at another commit is the opposite case — see the re-seed refusal
    // below, which is what must not become a second import.)
    routeSource({ liveSession: false });
    routeTarget({ existing: true, head: "9999999" });
    const base = handlers.dst;
    handlers.dst = (req) => {
      const res = base(req) as { type: string; workspaces?: { branch: string }[] };
      if (req.type === "list_workspaces" && res.workspaces) {
        return { ...res, workspaces: res.workspaces.map((w) => ({ ...w, branch: "lc/other" })) };
      }
      return res;
    };
    const { actions } = await import("./actions");

    await actions.transferWorkspace(input);

    expect(order).toContain("dst:import_workspace_from_remote");
  });

  it("does not count a carried transfer preamble as an already-delivered handover", async () => {
    // A workspace moved A→B arrives at C with B's preamble in its *seeded*
    // history. Reading that as a prior resume skipped hop two entirely — no
    // session, no message — while still archiving B.
    routeSource({ liveSession: false });
    routeTarget({ existing: true });
    const carried = {
      id: 1,
      role: "user",
      source: "fork",
      content: "This conversation moved from daemon office to src; the branch is at 1234567.",
    };
    const base = handlers.dst;
    let delivered = false;
    handlers.dst = (req) => {
      if (req.type === "queue_chat_input") delivered = true;
      if (req.type === "get_chat_snapshot") {
        return {
          type: "chat_snapshot",
          snapshot: {
            thread_id: 11,
            messages: delivered
              ? [
                  carried,
                  {
                    id: 2,
                    role: "user",
                    source: "user_send",
                    content: `This conversation moved from daemon src to dst; the branch is at ${PUSHED}.`,
                  },
                ]
              : [carried],
            events: [],
            provider_events: [],
            queued_inputs: [],
          },
        };
      }
      return base(req);
    };
    const { actions } = await import("./actions");

    await actions.transferWorkspace(input);

    expect(order).toContain("dst:ensure_chat_thread_session");
    expect(order).toContain("dst:queue_chat_input");
    expect(order).toContain("src:archive_workspace");
  });

  it("does not archive the source when an adopted target has none of the conversation", async () => {
    // Was: the resume step was skipped for a chatless target and the archive
    // ran anyway, reporting success while the work never arrived.
    routeSource({ liveSession: false });
    routeTarget({ existing: true, threads: [] });
    const { actions } = await import("./actions");

    const err = await actions.transferWorkspace(input).catch((e) => e);

    expect((err as Error).message).toContain("has none of the conversation");
    expect(order).not.toContain("src:archive_workspace");
    expect(order).not.toContain("dst:queue_chat_input");
  });

  it("opens a thread and sends the continuation prompt for an empty source chat", async () => {
    // An empty transcript seeds no thread on import, which is not a failure:
    // the chat is simply empty, so it gets a thread and the documented
    // continuation prompt.
    routeSource({ liveSession: false, transcript: [] });
    routeTarget({ existing: true, threads: [] });
    const { actions } = await import("./actions");

    await actions.transferWorkspace(input);

    expect(order).toContain("dst:create_chat_thread");
    const queued = api.requestClient.mock.calls.find(
      (c) => (c[1] as { type: string }).type === "queue_chat_input",
    );
    const text = (queued?.[1] as { input: string }).input;
    expect(text).toContain("Pick up where you left off");
    expect(text).not.toContain("port it");
    expect(order).toContain("src:archive_workspace");
  });

  it("refuses when both ends turn out to be the same daemon", async () => {
    // A saved client can point at the machine the app is running on, so the
    // configured addresses can differ while the daemon is one. A self-transfer
    // would archive the workspace it had just resumed.
    routeSource({ liveSession: false });
    routeTarget({ identity: "tok-src", identityPath: "/src/archcar.token" });
    const { actions } = await import("./actions");

    const err = await actions.transferWorkspace(input).catch((e) => e);

    expect((err as Error).message).toContain("are the same daemon reached two ways");
    expect(order).not.toContain("src:push_branch");
    expect(order).not.toContain("src:archive_workspace");
  });

  it("refuses to re-seed a target that has moved on with its own commits", async () => {
    // A completed transfer, re-run after the target's agent made its own
    // commits. The commit check used to read "not at our sha" as "not ours",
    // and import a *second* workspace onto the same branch — starting the
    // target's work twice.
    routeSource({ liveSession: false });
    routeTarget({ existing: true, head: "9f21abc" });
    const { actions } = await import("./actions");

    const err = await actions.transferWorkspace(input).catch((e) => e);

    expect((err as Error).message).toContain("has its own commits");
    expect(order).not.toContain("dst:import_workspace_from_remote");
    expect(order).not.toContain("dst:queue_chat_input");
    expect(order).not.toContain("src:archive_workspace");
  });

  it("moves off the environment-pinned daemon the sidebar is showing", async () => {
    // `ARCHDUCTOR_ARCHCAR_REMOTE` pins a daemon that has no client id and is
    // not this machine. Treating that as `null` sent every source call to this
    // machine's own socket while the sidebar showed the environment's daemon.
    routeSource({ liveSession: false });
    routeTarget();
    envIsSource = true;
    const { actions } = await import("./actions");

    await actions.transferWorkspace({ ...input, fromDaemon: { kind: "env" } });

    // Nothing went to this machine, and the source's calls went through the
    // transport that resolves the environment pin.
    expect(order.filter((entry) => entry.startsWith("local:"))).toEqual([]);
    expect(order).toContain("switcher:push_branch");
    expect(order).toContain("switcher:archive_workspace");
    expect(api.requestLocal).not.toHaveBeenCalled();
  });

  it("pins the source daemon, so switching clients mid-transfer cannot redirect it", async () => {
    // Was: every source call went through `send()`, which re-reads the selected
    // client per connection, so a switch part-way sent the rest — the final
    // archive included — to whichever daemon was selected by then.
    routeSource({ liveSession: false });
    routeTarget();
    const { actions } = await import("./actions");

    await actions.transferWorkspace(input);

    // Every step of the transfer itself is client-pinned. Only the UI's
    // inventory refresh afterwards follows the switcher, which is correct —
    // the sidebar shows whichever daemon is selected now.
    const archived = order.indexOf("src:archive_workspace");
    expect(archived).toBeGreaterThanOrEqual(0);
    const switcherDuringTransfer = order
      .slice(0, archived + 1)
      .filter((entry) => entry.startsWith("switcher:"));
    expect(switcherDuringTransfer).toEqual([]);
    // Most of all the irreversible call went to the daemon named at the start.
    const archive = api.requestClient.mock.calls.find(
      (c) => (c[1] as { type: string }).type === "archive_workspace",
    );
    expect(archive?.[0]).toBe("src");
    expect(order.filter((entry) => entry.startsWith("local:"))).toEqual([]);
  });
});

describe("transfer identity helpers", () => {
  it("compares the owner/repo tail across the forms two machines use", async () => {
    const { repositoryUrlTail } = await import("./actions");
    const expected = "me/app";
    for (const url of [
      "git@github.com:me/app.git",
      "https://github.com/me/app.git",
      "ssh://git@github.com:22/me/app",
      "https://github.com/me/app/",
    ]) {
      expect(repositoryUrlTail(url)).toBe(expected);
    }
    expect(repositoryUrlTail("git@github.com:you/app.git")).not.toBe(expected);
  });

  it("matches abbreviated shas by shared prefix, and refuses short or non-hex ones", async () => {
    const { commitsMatch } = await import("./actions");
    expect(commitsMatch("abc1234", "abc1234def5678")).toBe(true);
    expect(commitsMatch("abc1234def5678", "abc1234")).toBe(true);
    expect(commitsMatch("abc1234", "9999999")).toBe(false);
    // Too short to be meaningful, and not a sha at all.
    expect(commitsMatch("abc12", "abc12")).toBe(false);
    expect(commitsMatch("notahex", "notahex")).toBe(false);
    expect(commitsMatch(undefined, "abc1234")).toBe(false);
  });
});
