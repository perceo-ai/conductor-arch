// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import type { ComposerNode } from "@/lib/composerDocument";

// Fresh modules per test: nav's realm and the draft map are module state, and
// solid-js is re-imported with them so the lifecycle's effects and the test's
// root share one reactive runtime.
async function launch() {
  vi.resetModules();
  const solid = await import("solid-js");
  const { createComposerDraftLifecycle } = await import("./draftLifecycle");
  const { nav, UNASSIGNED_REALM } = await import("@/store/nav");
  const { composerDrafts, draftKey } = await import("@/lib/composerDrafts");
  return { solid, createComposerDraftLifecycle, nav, UNASSIGNED_REALM, composerDrafts, draftKey };
}

function textNode(text: string): ComposerNode[] {
  return [{ kind: "text", text }];
}

/** Mount one composer's draft lifecycle under its own root. */
function mount(
  l: Awaited<ReturnType<typeof launch>>,
  threadId: () => number,
) {
  const screen = { nodes: [] as ComposerNode[] };
  let dispose!: () => void;
  l.solid.createRoot((d) => {
    dispose = d;
    const { initialNodes } = l.createComposerDraftLifecycle({
      threadId,
      currentNodes: () => screen.nodes,
      restore: (restored) => {
        screen.nodes = restored;
      },
    });
    screen.nodes = initialNodes;
  });
  return { screen, dispose };
}

describe("composer draft lifecycle", () => {
  it("keeps the draft when startup corrects the realm while the composer is mounted", async () => {
    const l = await launch();
    expect(l.nav.tabRealm()).toBe(l.UNASSIGNED_REALM);
    const [threadId, setThreadId] = l.solid.createSignal(5);
    const { screen, dispose } = mount(l, threadId);

    screen.nodes = textNode("half a prompt"); // typed before startup finished
    l.nav.setTabRealm("local"); // startup's correction, not a switch
    setThreadId(9); // open another chat: parks thread 5's draft
    expect(screen.nodes).toEqual([]);
    setThreadId(5); // and come back

    expect(screen.nodes).toEqual(textNode("half a prompt"));
    dispose();
  });

  it("migrates drafts already parked under the unassigned realm on correction", async () => {
    const l = await launch();
    const [threadId, setThreadId] = l.solid.createSignal(5);
    const { screen, dispose } = mount(l, threadId);

    screen.nodes = textNode("chat five");
    setThreadId(9); // parks thread 5's draft under the unassigned realm
    screen.nodes = textNode("chat nine");
    l.nav.setTabRealm("local"); // correction happens while 5's draft is parked
    setThreadId(5);

    expect(screen.nodes).toEqual(textNode("chat five"));
    setThreadId(9);
    expect(screen.nodes).toEqual(textNode("chat nine"));
    dispose();
  });

  it("a genuine daemon switch still keeps each realm's drafts apart", async () => {
    const l = await launch();
    l.nav.setTabRealm("local");
    const [threadId] = l.solid.createSignal(5);
    const first = mount(l, threadId);
    first.screen.nodes = textNode("daemon A text");

    // An explicit switch replaces the realm session: nothing is retargeted,
    // and the unmounting composer parks under the realm it was opened in.
    l.nav.deferTabRestore({ daemonSwitch: true });
    l.nav.restoreWorkspaceTabs("client:b", () => true);
    first.dispose();

    // Daemon B's same-numbered thread starts empty; A's draft stays A's.
    const second = mount(l, threadId);
    expect(second.screen.nodes).toEqual([]);
    expect(l.composerDrafts.get(l.draftKey("local", 5))).toEqual(textNode("daemon A text"));
    second.dispose();
  });
});
