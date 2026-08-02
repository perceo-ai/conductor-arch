// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Covers the state-changing actions: each sends the right archcar request,
// re-pulls the inventory on success (archcar has no inventory-changed event),
// and surfaces an error response as a thrown error.

interface MockApi {
  request: ReturnType<typeof vi.fn>;
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
