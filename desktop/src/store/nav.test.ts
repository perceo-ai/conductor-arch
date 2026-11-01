// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

async function freshNav() {
  vi.resetModules();
  return (await import("./nav")).nav;
}

// Node's own localStorage global is unusable in vitest; every nav mutation
// persists tabs through it, so give the whole file a working in-memory one.
const storage = new Map<string, string>();
vi.stubGlobal("localStorage", {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => void storage.set(key, value),
});

function tabsOf(nav: Awaited<ReturnType<typeof freshNav>>) {
  return nav.workspaceTabs().groups.map((group) => ({ tabs: group.tabs, active: group.active }));
}

describe("nav workspace tabs", () => {
  beforeEach(() => {
    vi.resetModules();
    storage.clear();
  });

  it("opens each selected workspace as a tab and returns to its last chat", async () => {
    const nav = await freshNav();
    nav.selectWorkspace("alpha");
    nav.selectChatThread(11);
    nav.selectWorkspace("beta");
    expect(nav.selectedChatThread()).toBeNull();
    nav.selectChatThread(22);

    nav.selectWorkspace("alpha");
    expect(tabsOf(nav)).toEqual([{ tabs: ["alpha", "beta"], active: "alpha" }]);
    expect(nav.selectedChatThread()).toBe(11);
    nav.selectWorkspace("beta");
    expect(nav.selectedChatThread()).toBe(22);
  });

  it("makes the focused pane's active tab the selected workspace", async () => {
    const nav = await freshNav();
    nav.selectWorkspace("alpha");
    nav.selectChatThread(11);
    nav.selectWorkspace("beta");
    nav.selectChatThread(22);

    nav.splitWorkspaceTab("beta", "right");
    expect(tabsOf(nav)).toEqual([
      { tabs: ["alpha"], active: "alpha" },
      { tabs: ["beta"], active: "beta" },
    ]);
    expect(nav.selectedWorkspace()).toBe("beta");

    nav.focusTabGroup(0);
    expect(nav.selectedWorkspace()).toBe("alpha");
    expect(nav.selectedChatThread()).toBe(11);
    // The unfocused pane still shows its own chat.
    expect(nav.threadFor("beta")).toBe(22);
  });

  it("selects a chat in the unfocused pane without stealing focus", async () => {
    const nav = await freshNav();
    nav.selectWorkspace("alpha");
    nav.selectWorkspace("beta");
    nav.splitWorkspaceTab("beta", "right");
    nav.focusTabGroup(0);

    nav.selectThreadFor("beta", 33);
    expect(nav.selectedWorkspace()).toBe("alpha");
    expect(nav.threadFor("beta")).toBe(33);
  });

  it("counts a chat as on screen in either pane", async () => {
    const nav = await freshNav();
    nav.selectWorkspace("alpha");
    nav.selectChatThread(11);
    nav.selectWorkspace("beta");
    nav.selectChatThread(22);
    nav.splitWorkspaceTab("beta", "down");

    expect(nav.chatThreadInView(22)).toBe(true);
    expect(nav.chatThreadInView(11)).toBe(true);
    expect(nav.chatThreadInView(99)).toBe(false);
    nav.setChatSurfaceShowsChat(false);
    expect(nav.chatThreadInView(22)).toBe(false);
  });

  it("falls back to the dashboard when the last tab closes", async () => {
    const nav = await freshNav();
    nav.selectWorkspace("alpha");
    nav.closeWorkspaceTab("alpha");
    expect(nav.selectedWorkspace()).toBeNull();
    expect(nav.activePage()).toBe("dashboard");
  });

  it("moves selection to the other pane when the focused pane's last tab closes", async () => {
    const nav = await freshNav();
    nav.selectWorkspace("alpha");
    nav.selectWorkspace("beta");
    nav.splitWorkspaceTab("beta", "right");
    nav.closeWorkspaceTab("beta");
    expect(tabsOf(nav)).toEqual([{ tabs: ["alpha"], active: "alpha" }]);
    expect(nav.selectedWorkspace()).toBe("alpha");
    expect(nav.activePage()).toBe("workspace");
  });

  it("opens a workspace in a split beside what is on screen", async () => {
    const nav = await freshNav();
    nav.selectWorkspace("alpha");
    nav.openWorkspaceInSplit("beta", "right");
    expect(tabsOf(nav)).toEqual([
      { tabs: ["alpha"], active: "alpha" },
      { tabs: ["beta"], active: "beta" },
    ]);
    // Already beside: asking again only focuses it, it does not bounce back.
    nav.focusTabGroup(0);
    nav.openWorkspaceInSplit("beta", "right");
    expect(tabsOf(nav)).toEqual([
      { tabs: ["alpha"], active: "alpha" },
      { tabs: ["beta"], active: "beta" },
    ]);
    expect(nav.selectedWorkspace()).toBe("beta");
  });

  it("follows a rename in the tab, the selection, and the chat memory", async () => {
    const nav = await freshNav();
    nav.selectWorkspace("alpha");
    nav.selectChatThread(11);
    nav.renameWorkspace("alpha", "alpha-renamed");
    expect(tabsOf(nav)).toEqual([{ tabs: ["alpha-renamed"], active: "alpha-renamed" }]);
    expect(nav.selectedWorkspace()).toBe("alpha-renamed");
    expect(nav.threadFor("alpha-renamed")).toBe(11);
  });

  it("drops tabs for workspaces that are gone", async () => {
    const nav = await freshNav();
    nav.selectWorkspace("alpha");
    nav.selectWorkspace("beta");
    nav.retainWorkspaceTabs((name) => name !== "beta");
    expect(tabsOf(nav)).toEqual([{ tabs: ["alpha"], active: "alpha" }]);
    expect(nav.selectedWorkspace()).toBe("alpha");
  });

  it("restores the saved tabs, chats, and page after a restart", async () => {
    const before = await freshNav();
    before.selectWorkspace("alpha");
    before.selectChatThread(11);
    before.selectWorkspace("beta");
    before.splitWorkspaceTab("beta", "down");

    // A fresh module is a fresh app launch; only localStorage carries over.
    const after = await freshNav();
    expect(after.activePage()).toBe("dashboard");
    after.restoreWorkspaceTabs("local", () => true);
    expect(tabsOf(after)).toEqual([
      { tabs: ["alpha"], active: "alpha" },
      { tabs: ["beta"], active: "beta" },
    ]);
    expect(after.workspaceTabs().direction).toBe("down");
    expect(after.selectedWorkspace()).toBe("beta");
    expect(after.activePage()).toBe("workspace");
    expect(after.threadFor("alpha")).toBe(11);
  });

  it("drops deleted workspaces on restore and stays on the dashboard when nothing survives", async () => {
    const before = await freshNav();
    before.selectWorkspace("alpha");
    before.selectWorkspace("beta");

    const partial = await freshNav();
    partial.restoreWorkspaceTabs("local", (name) => name === "alpha");
    expect(tabsOf(partial)).toEqual([{ tabs: ["alpha"], active: "alpha" }]);

    const none = await freshNav();
    none.restoreWorkspaceTabs("local", () => false);
    expect(tabsOf(none)).toEqual([{ tabs: [], active: null }]);
    expect(none.activePage()).toBe("dashboard");
  });

  it("keeps each daemon realm's tabs apart", async () => {
    const local = await freshNav();
    local.selectWorkspace("alpha");

    const remote = await freshNav();
    remote.restoreWorkspaceTabs("client:x", () => true);
    expect(tabsOf(remote)).toEqual([{ tabs: [], active: null }]);
    remote.selectWorkspace("remote-ws");

    const back = await freshNav();
    back.restoreWorkspaceTabs("local", () => true);
    expect(tabsOf(back)).toEqual([{ tabs: ["alpha"], active: "alpha" }]);
    back.restoreWorkspaceTabs("client:x", () => true);
    expect(tabsOf(back)).toEqual([{ tabs: ["remote-ws"], active: "remote-ws" }]);
  });

  it("reopens a closed workspace's tab on back", async () => {
    const nav = await freshNav();
    nav.selectWorkspace("alpha");
    nav.selectWorkspace("beta");
    nav.closeWorkspaceTab("alpha");
    nav.back();
    expect(nav.selectedWorkspace()).toBe("alpha");
    expect(nav.workspaceTabs().groups[0].tabs).toContain("alpha");
  });
});
