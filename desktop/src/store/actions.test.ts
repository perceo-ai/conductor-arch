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
  it("sends delete_workspace with cleanup flags", async () => {
    routeByType({ delete_workspace: { type: "workspace_removed", name: "berlin" } });
    const { actions } = await import("./actions");
    await actions.deleteWorkspace("berlin", true, true);

    const call = api.request.mock.calls
      .map((c) => c[0] as Record<string, unknown>)
      .find((p) => p.type === "delete_workspace");
    expect(call).toMatchObject({
      type: "delete_workspace",
      workspace: "berlin",
      remove_worktree: true,
      delete_branch: true,
    });
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
