// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

async function freshNav() {
  vi.resetModules();
  return (await import("./nav")).nav;
}

/**
 * A fresh launch that will WRITE tab state for the local machine: nothing
 * persists while the realm is unassigned, so stamp it the way startup does.
 * Readers assign the realm through their own restoreWorkspaceTabs call.
 */
async function freshLocalNav() {
  const nav = await freshNav();
  nav.setTabRealm("local");
  return nav;
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
    const before = await freshLocalNav();
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
    const before = await freshLocalNav();
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
    const local = await freshLocalNav();
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

  describe("leaving the unassigned realm migrates parked drafts", () => {
    /**
     * Drafts parked while the realm was still unassigned belong to the daemon
     * startup is about to identify. The migration must run where the
     * correction happens — components that parked them may be long unmounted.
     */
    async function freshStores() {
      vi.resetModules();
      const { nav, UNASSIGNED_REALM } = await import("./nav");
      const { composerDrafts, draftKey } = await import("@/lib/composerDrafts");
      const { editorDraftStash } = await import("@/lib/editorDraftStash");
      return { nav, UNASSIGNED_REALM, composerDrafts, draftKey, editorDraftStash };
    }

    it("moves a composer draft parked with no composer mounted", async () => {
      const { nav, UNASSIGNED_REALM, composerDrafts, draftKey } = await freshStores();
      composerDrafts.save(draftKey(UNASSIGNED_REALM, 5), [{ kind: "text", text: "early" }]);

      nav.setTabRealm("client:a"); // startup's correction; nothing is mounted

      expect(composerDrafts.get(draftKey("client:a", 5))).toEqual([{ kind: "text", text: "early" }]);
      expect(composerDrafts.get(draftKey(UNASSIGNED_REALM, 5))).toEqual([]);
    });

    it("moves a file-editor draft parked with no editor mounted", async () => {
      const { nav, UNASSIGNED_REALM, editorDraftStash } = await freshStores();
      editorDraftStash.park(UNASSIGNED_REALM, "ws", "src/f.ts", "early edit");

      nav.setTabRealm("client:a");

      expect(editorDraftStash.take("client:a", "ws", "src/f.ts")).toBe("early edit");
      expect(editorDraftStash.take(UNASSIGNED_REALM, "ws", "src/f.ts")).toBeNull();
    });

    it("does not migrate on a declared daemon switch, even from the unassigned realm", async () => {
      const { nav, UNASSIGNED_REALM, composerDrafts, draftKey, editorDraftStash } = await freshStores();
      composerDrafts.save(draftKey(UNASSIGNED_REALM, 5), [{ kind: "text", text: "early" }]);
      editorDraftStash.park(UNASSIGNED_REALM, "ws", "src/f.ts", "early edit");

      nav.deferTabRestore({ daemonSwitch: true });
      nav.restoreWorkspaceTabs("local", () => true);

      // The other daemon's drafts must not leak into this one.
      expect(composerDrafts.get(draftKey("local", 5))).toEqual([]);
      expect(editorDraftStash.take("local", "ws", "src/f.ts")).toBeNull();
      expect(composerDrafts.get(draftKey(UNASSIGNED_REALM, 5))).toEqual([{ kind: "text", text: "early" }]);
      expect(editorDraftStash.take(UNASSIGNED_REALM, "ws", "src/f.ts")).toBe("early edit");
    });

    it("migrates exactly once, on the assignment that leaves the sentinel", async () => {
      const { nav, UNASSIGNED_REALM, composerDrafts, draftKey } = await freshStores();
      nav.setTabRealm("local"); // the one sentinel -> real transition
      // Anything that lands under the sentinel afterwards is a bug of its
      // own, not something later assignments may quietly re-home.
      composerDrafts.save(draftKey(UNASSIGNED_REALM, 7), [{ kind: "text", text: "stray" }]);
      const kept = [{ kind: "text", text: "mine" }];
      composerDrafts.save(draftKey("local", 7), kept);

      nav.setTabRealm("local"); // repeated correction, same realm
      nav.deferTabRestore({ daemonSwitch: true });
      nav.restoreWorkspaceTabs("client:b", () => true); // later genuine switch

      expect(composerDrafts.get(draftKey(UNASSIGNED_REALM, 7))).toEqual([{ kind: "text", text: "stray" }]);
      expect(composerDrafts.get(draftKey("local", 7))).toEqual(kept);
      expect(composerDrafts.get(draftKey("client:b", 7))).toEqual([]);
    });
  });

  it("replaces the realm session on a declared switch out of the unassigned placeholder", async () => {
    // Startup never learned the realm (event subscription failed): still
    // unassigned. The user explicitly switches to "This machine".
    vi.resetModules();
    const { nav, UNASSIGNED_REALM } = await import("./nav");
    const before = nav.tabRealmSession();
    expect(nav.tabRealm()).toBe(UNASSIGNED_REALM);
    nav.deferTabRestore({ daemonSwitch: true });
    nav.restoreWorkspaceTabs("local", () => true);

    // A declared switch replaces the session even from the unassigned state:
    // views keyed on it must remount, or the old daemon's text saves to the
    // new daemon's file.
    expect(nav.tabRealm()).toBe("local");
    expect(nav.tabRealmSession()).not.toBe(before);
    expect(before.realm).toBe(UNASSIGNED_REALM);
  });

  it("persists nothing while the realm is unassigned, then saves the screen on assignment", async () => {
    vi.resetModules();
    const { nav } = await import("./nav");
    nav.selectWorkspace("early");
    // Nothing may land under the sentinel key, and "local" is untouched.
    expect(storage.size).toBe(0);
    nav.setTabRealm("local");
    expect(storage.size).toBe(1);
    const fresh = await freshNav();
    fresh.restoreWorkspaceTabs("local", () => true);
    expect(tabsOf(fresh)).toEqual([{ tabs: ["early"], active: "early" }]);
  });

  it("selects the restored realm's chat even when the workspace name matches", async () => {
    const local = await freshLocalNav();
    local.selectWorkspace("shared-name");
    local.selectChatThread(11);

    const remote = await freshNav();
    remote.restoreWorkspaceTabs("client:x", () => true);
    remote.selectWorkspace("shared-name");
    remote.selectChatThread(77);

    // Same selected workspace name on both daemons; thread 11 is local's.
    remote.restoreWorkspaceTabs("local", () => true);
    expect(remote.selectedWorkspace()).toBe("shared-name");
    expect(remote.selectedChatThread()).toBe(11);
    remote.restoreWorkspaceTabs("client:x", () => true);
    expect(remote.selectedChatThread()).toBe(77);
  });

  it("pauses persistence while a restore is owed, so stale pruning cannot stick", async () => {
    const before = await freshLocalNav();
    before.selectWorkspace("alpha");
    before.selectWorkspace("beta");

    const during = await freshNav();
    during.deferTabRestore();
    expect(during.awaitingTabRestore()).toBe(true);
    // The destructive sequence a daemon switch used to run: prune the old
    // tabs against the new daemon's inventory before the realm moved over.
    during.selectWorkspace("alpha");
    during.retainWorkspaceTabs(() => false);
    // Storage still holds the saved tabs: nothing persisted while owed.
    const after = await freshNav();
    after.restoreWorkspaceTabs("local", () => true);
    expect(after.awaitingTabRestore()).toBe(false);
    expect(tabsOf(after)).toEqual([{ tabs: ["alpha", "beta"], active: "beta" }]);
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
