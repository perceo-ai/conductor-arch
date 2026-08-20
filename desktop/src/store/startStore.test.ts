// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Covers the startup flow introduced in App.onMount → startStore():
// serialize concurrent init, reset on failure so a later call retries, and the
// connectEvents listener cleanup on ensureEvents rejection. These are the
// behaviors flagged in review; they're testable at the store/bridge layer
// without rendering the Solid component (no jsdom needed — we stub the preload
// bridge that the renderer would normally receive from Electron).

interface MockApi {
  request: ReturnType<typeof vi.fn>;
  ensureEvents: ReturnType<typeof vi.fn>;
  onEvent: ReturnType<typeof vi.fn>;
  onWindowFocus: ReturnType<typeof vi.fn>;
  pathExists: ReturnType<typeof vi.fn>;
  window: { minimize: () => void; toggleMaximize: () => void; close: () => void };
}

let offEvent: ReturnType<typeof vi.fn>;
let api: MockApi;

const workspaceSummary = (id: number, name: string, status = "active") => ({
  id,
  name,
  repository_name: "demo",
  path: `/tmp/${name}`,
  branch: name,
  base_ref: "main",
  status,
  open_todos: 0,
  active_sessions: 0,
  run_running: false,
  changed_files: 0,
  diff_additions: 0,
  diff_deletions: 0,
  updated_at: "2026-08-18T00:00:00Z",
});

beforeEach(() => {
  vi.resetModules();
  offEvent = vi.fn();
  api = {
    request: vi.fn(async () => ({ type: "workspaces", workspaces: [] })),
    ensureEvents: vi.fn(async () => ({ ok: true })),
    onEvent: vi.fn(() => offEvent),
    onWindowFocus: vi.fn(() => () => {}),
    pathExists: vi.fn(async () => ({ exists: true })),
    window: { minimize: () => {}, toggleMaximize: () => {}, close: () => {} },
  };
  (globalThis as unknown as { window: { archductor: MockApi } }).window = { archductor: api };
});

afterEach(() => {
  delete (globalThis as { window?: unknown }).window;
});

describe("startStore", () => {
  it("shares one in-flight init across concurrent callers", async () => {
    const { startStore } = await import("./index");
    const a = startStore();
    const b = startStore();
    expect(a).toBe(b);
    await a;
    // ensureEvents (the subscribe handshake) ran exactly once for both callers.
    expect(api.ensureEvents).toHaveBeenCalledTimes(1);
  });

  it("loads startup inventory through one archcar snapshot request", async () => {
    api.request.mockImplementation(async (req: { type: string }) => {
      if (req.type === "get_inventory_snapshot") {
        return {
          type: "inventory_snapshot",
          repositories: [],
          workspaces: [],
          chat_threads: {},
        };
      }
      return { type: "ack" };
    });
    const { startStore } = await import("./index");

    await startStore();

    expect(api.request).toHaveBeenCalledWith({ type: "get_inventory_snapshot" });
    expect(api.request).not.toHaveBeenCalledWith({ type: "list_workspaces" });
    expect(api.request).not.toHaveBeenCalledWith({ type: "list_repositories" });
  });

  it("resets after a failed init so a later call retries", async () => {
    api.ensureEvents.mockRejectedValueOnce(new Error("daemon down"));
    const { startStore } = await import("./index");

    await expect(startStore()).rejects.toThrow("daemon down");
    // Failure must not leak the event listener registered in connectEvents.
    expect(offEvent).toHaveBeenCalledTimes(1);

    // A subsequent call re-attempts (memo was cleared) and now succeeds.
    await expect(startStore()).resolves.toBeUndefined();
    expect(api.ensureEvents).toHaveBeenCalledTimes(2);
  });
});

describe("refreshInventory: missing-on-disk repositories", () => {
  const repoSummary = (id: number, name: string, root: string) => ({
    id,
    name,
    root_path: root,
    default_branch: "main",
    remote_name: "origin",
    active_workspaces: 0,
    total_workspaces: 0,
  });

  beforeEach(() => {
    api.request.mockImplementation(async (req: { type: string }) => {
      if (req.type === "list_repositories") {
        return {
          type: "repositories",
          repositories: [
            repoSummary(1, "here", "/exists/here"),
            repoSummary(2, "gone", "/deleted/gone"),
          ],
        };
      }
      return { type: "workspaces", workspaces: [] };
    });
    api.pathExists.mockImplementation(async (p: string) => ({
      exists: p === "/exists/here",
    }));
  });

  it("keeps repos whose root is missing visible so they can be removed", async () => {
    const { refreshInventory, repositoriesStore } = await import("./index");
    await refreshInventory();

    // A missing-on-disk repo stays in the sidebar (not hidden) so the user can
    // remove the dead project via the right-click "Remove project" action.
    expect(repositoriesStore.state.order).toEqual(["here", "gone"]);
    expect(repositoriesStore.row("gone")).toBeTruthy();
    // refreshInventory itself does not send any destructive remove_repository RPC.
    expect(api.request).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "remove_repository" }),
    );
  });

  it("refreshes chat tabs for every active workspace after inventory loads", async () => {
    api.request.mockImplementation(async (req: { type: string; workspace?: string }) => {
      if (req.type === "list_workspaces") {
        return {
          type: "workspaces",
          workspaces: [
            workspaceSummary(1, "alpha"),
            workspaceSummary(2, "beta"),
            workspaceSummary(3, "old", "archived"),
          ],
        };
      }
      if (req.type === "list_repositories") return { type: "repositories", repositories: [] };
      if (req.type === "list_chat_threads") {
        return {
          type: "chat_threads",
          workspace: req.workspace,
          threads: [
            {
              id: req.workspace === "alpha" ? 10 : 20,
              provider: "codex",
              title: "Chat",
              status: "active",
              updated_at: "2026-08-18T00:00:00Z",
            },
          ],
        };
      }
      return { type: "ack" };
    });

    const { refreshInventory, threadsStore } = await import("./index");
    await refreshInventory();

    expect(api.request).toHaveBeenCalledWith({ type: "list_chat_threads", workspace: "alpha" });
    expect(api.request).toHaveBeenCalledWith({ type: "list_chat_threads", workspace: "beta" });
    expect(api.request).not.toHaveBeenCalledWith({ type: "list_chat_threads", workspace: "old" });
    expect(threadsStore.workspaceForThread(10)).toBe("alpha");
    expect(threadsStore.workspaceForThread(20)).toBe("beta");
  });
});
