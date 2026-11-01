// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface MockApi {
  request: ReturnType<typeof vi.fn>;
  requestLocal: ReturnType<typeof vi.fn>;
  clientsActivate: ReturnType<typeof vi.fn>;
  clientsList: ReturnType<typeof vi.fn>;
  clientsAdd: ReturnType<typeof vi.fn>;
  clientsRemove: ReturnType<typeof vi.fn>;
  clientsRename: ReturnType<typeof vi.fn>;
  log: ReturnType<typeof vi.fn>;
}

let api: MockApi;
let activeClient: string | null;

const clients = [
  { id: "devbox", label: "Devbox", address: "devbox:7420" },
  { id: "laptop", label: "Laptop", address: "laptop:7420" },
];

const workspaceSummary = (id: number, name: string) => ({
  id,
  name,
  repository_name: "demo",
  path: `/tmp/${activeClient ?? "local"}/${name}`,
  branch: name,
  base_ref: "main",
  status: "active",
  open_todos: 0,
  active_sessions: 0,
  run_running: false,
  changed_files: 0,
  diff_additions: 0,
  diff_deletions: 0,
  updated_at: "2026-08-18T00:00:00Z",
});

function workspacesForActiveClient() {
  if (activeClient === "devbox") return [workspaceSummary(1, "remote-alpha")];
  if (activeClient === "laptop") return [workspaceSummary(2, "remote-beta")];
  return [workspaceSummary(3, "local-alpha")];
}

beforeEach(() => {
  vi.resetModules();
  activeClient = null;
  api = {
    request: vi.fn(async (req: { type: string }) => {
      if (req.type === "get_inventory_snapshot") {
        return {
          type: "inventory_snapshot",
          repositories: [],
          workspaces: workspacesForActiveClient(),
          chat_threads: {},
        };
      }
      if (req.type === "list_workspaces") {
        return { type: "workspaces", workspaces: workspacesForActiveClient() };
      }
      if (req.type === "list_repositories") return { type: "repositories", repositories: [] };
      if (req.type === "list_agent_providers") return { type: "agent_providers", providers: [] };
      if (req.type === "get_setup_readiness") {
        return { type: "setup_readiness", report: { rows: [], feedback: "", complete: true } };
      }
      if (req.type === "list_layout_presets") return { type: "layout_presets", presets: [] };
      return { type: "ack" };
    }),
    requestLocal: vi.fn(),
    clientsActivate: vi.fn(async (id: string | null) => {
      activeClient = id;
      return { ok: true, activeId: id, clients };
    }),
    clientsList: vi.fn(async () => ({ ok: true, activeId: activeClient, clients })),
    clientsAdd: vi.fn(),
    clientsRemove: vi.fn(),
    clientsRename: vi.fn(),
    log: vi.fn(),
  };
  (globalThis as unknown as { window: { archductor: MockApi } }).window = { archductor: api };
});

afterEach(() => {
  delete (globalThis as { window?: unknown }).window;
});

describe("clientsStore navigation", () => {
  it("does not carry an open workspace from the previous daemon and restores each daemon's last workspace", async () => {
    const { clientsStore, nav, refreshInventory } = await import("./index");

    await refreshInventory();
    nav.selectWorkspace("local-alpha");

    await clientsStore.activate("devbox");
    expect(nav.activePage()).toBe("dashboard");
    expect(nav.selectedWorkspace()).toBeNull();

    nav.selectWorkspace("remote-alpha");
    await clientsStore.activate("laptop");
    expect(nav.activePage()).toBe("dashboard");
    expect(nav.selectedWorkspace()).toBeNull();

    nav.selectWorkspace("remote-beta");
    await clientsStore.activate("devbox");
    expect(nav.activePage()).toBe("workspace");
    expect(nav.selectedWorkspace()).toBe("remote-alpha");

    await clientsStore.activate(null);
    expect(nav.activePage()).toBe("workspace");
    expect(nav.selectedWorkspace()).toBe("local-alpha");
  });
});

describe("clientsStore failed switches", () => {
  /**
   * A switch pauses tab persistence until the new daemon's restore runs. When
   * the switch itself fails there is no restore coming, so the pause has to be
   * lifted — otherwise every later tab change silently stops being saved.
   */
  async function openLocalTab() {
    const mod = await import("./index");
    await mod.refreshInventory();
    mod.nav.selectWorkspace("local-alpha");
    return { ...mod, before: JSON.stringify(mod.nav.workspaceTabs()) };
  }

  it("activate: an error result lifts the pause and leaves the tabs alone", async () => {
    const { clientsStore, nav, before } = await openLocalTab();
    api.clientsActivate.mockResolvedValueOnce({ ok: false, error: "devbox unreachable" });

    expect(await clientsStore.activate("devbox")).toBe(false);

    expect(nav.awaitingTabRestore()).toBe(false);
    expect(JSON.stringify(nav.workspaceTabs())).toBe(before);
  });

  it("activate: a thrown bridge call lifts the pause and leaves the tabs alone", async () => {
    const { clientsStore, nav, before } = await openLocalTab();
    api.clientsActivate.mockRejectedValueOnce(new Error("ipc closed"));

    expect(await clientsStore.activate("devbox")).toBe(false);

    expect(nav.awaitingTabRestore()).toBe(false);
    expect(JSON.stringify(nav.workspaceTabs())).toBe(before);
  });

  it("add: a failed verify lifts the pause and leaves the tabs alone", async () => {
    const { clientsStore, nav, before } = await openLocalTab();
    api.clientsAdd.mockResolvedValueOnce({ ok: false, error: "bad token" });

    expect(await clientsStore.add({ address: "new:7420", token: "t" })).toBe(false);

    expect(nav.awaitingTabRestore()).toBe(false);
    expect(JSON.stringify(nav.workspaceTabs())).toBe(before);
  });

  it("remove of the active client: a failure lifts the pause and leaves the tabs alone", async () => {
    const { clientsStore, nav, refreshInventory } = await import("./index");
    await refreshInventory();
    expect(await clientsStore.activate("devbox")).toBe(true);
    nav.selectWorkspace("remote-alpha");
    const before = JSON.stringify(nav.workspaceTabs());
    api.clientsRemove.mockResolvedValueOnce({ ok: false, error: "clients.json is read-only" });

    expect(await clientsStore.remove("devbox")).toBe(false);

    expect(nav.awaitingTabRestore()).toBe(false);
    expect(JSON.stringify(nav.workspaceTabs())).toBe(before);
  });
});

describe("clientsStore.selectedDaemon", () => {
  /**
   * Everything that needs to *address* the selected daemon reads this, and
   * everything that describes it on screen derives from it — so a transfer
   * cannot operate on a different daemon than the sidebar is showing. The case
   * that used to disagree is `ARCHDUCTOR_ARCHCAR_REMOTE`: it has no client id,
   * so a nullable id read it as "this machine" while the UI called it remote.
   */
  it("reports the environment pin as its own case, not as this machine", async () => {
    api.clientsList = vi.fn(async () => ({
      ok: true,
      activeId: null,
      clients,
      envAddress: "office:7420",
    }));
    const { clientsStore } = await import("./index");
    await clientsStore.refresh();

    expect(clientsStore.selectedDaemon()).toEqual({ kind: "env" });
    // And the three answers agree, which is the whole point.
    expect(clientsStore.isRemote()).toBe(true);
    expect(clientsStore.activeLabel()).toBe("office:7420");
    expect(clientsStore.pinned()).toBe(true);
  });

  it("reports a saved client by id, and this machine as local", async () => {
    const { clientsStore } = await import("./index");
    await clientsStore.refresh();
    expect(clientsStore.selectedDaemon()).toEqual({ kind: "local" });
    expect(clientsStore.isRemote()).toBe(false);
    expect(clientsStore.activeLabel()).toBe("This machine");

    await clientsStore.activate("devbox");
    expect(clientsStore.selectedDaemon()).toEqual({ kind: "client", clientId: "devbox" });
    expect(clientsStore.isRemote()).toBe(true);
    expect(clientsStore.activeLabel()).toBe("Devbox");
  });
});
