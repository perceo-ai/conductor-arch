// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

const send = vi.fn(async (request: { type: string }) => {
  if (request.type === "read_workspace_file") {
    return { type: "workspace_file_content", content: "saved text\n" };
  }
  if (request.type === "get_workspace_diff") {
    return { type: "workspace_diff", workspace: "ws", diff: "" };
  }
  if (request.type === "list_review_comments") {
    return { type: "review_comments", comments: [] };
  }
  throw new Error(`Unexpected request: ${request.type}`);
});

vi.mock("@/bridge/client", () => ({ send }));

// Each test is a fresh app launch: nav's realm state (and the stash) are
// module-level, and the startup case needs a realm that was never known yet.
// solid-js is re-imported with them so render and the components share one
// reactive runtime.
async function launch() {
  vi.resetModules();
  const { render } = await import("solid-js/web");
  const { FileView } = await import("./FileViews");
  const { nav } = await import("@/store/nav");
  const { editorDraftStash } = await import("@/lib/editorDraftStash");
  return { render, FileView, nav, editorDraftStash };
}

async function openEditorAndEdit(
  render: Awaited<ReturnType<typeof launch>>["render"],
  FileView: Awaited<ReturnType<typeof launch>>["FileView"],
) {
  const host = document.createElement("div");
  document.body.append(host);
  dispose = render(() => <FileView workspace="ws" path="src/f.ts" />, host);
  const editButton = [...host.querySelectorAll<HTMLButtonElement>("button")].find(
    (b) => b.textContent === "Edit",
  )!;
  editButton.click();
  const area = await vi.waitFor(() => {
    const el = host.querySelector<HTMLTextAreaElement>("textarea.ws-file-editor-area");
    expect(el?.value).toBe("saved text\n");
    return el!;
  });
  area.value = "unsaved edit\n";
  area.dispatchEvent(new Event("input", { bubbles: true }));
  return { host, area };
}

let dispose: (() => void) | undefined;

afterEach(() => {
  dispose?.();
  dispose = undefined;
  document.body.innerHTML = "";
  send.mockClear();
});

describe("FileEditor draft stash", () => {
  it("remounts the editor on a daemon switch, parking the old editor's draft under its own realm", async () => {
    const { render, FileView, nav, editorDraftStash } = await launch();
    // Opened while pointed at daemon-a.
    nav.restoreWorkspaceTabs("daemon-a", () => true);
    const { host, area } = await openEditorAndEdit(render, FileView);

    // A daemon switch that lands on a workspace with the same name keeps the
    // file view mounted. The editor itself must not survive it: its cached
    // realm would hand the new daemon the old daemon's drafts.
    nav.restoreWorkspaceTabs("daemon-b", () => true);
    expect(nav.tabRealm()).toBe("daemon-b");

    const fresh = await vi.waitFor(() => {
      const el = host.querySelector<HTMLTextAreaElement>("textarea.ws-file-editor-area");
      expect(el).toBeTruthy();
      expect(el).not.toBe(area);
      expect(el!.value).toBe("saved text\n");
      return el!;
    });
    expect(fresh.isConnected).toBe(true);
    expect(area.isConnected).toBe(false);

    // The torn-down editor parked under the realm it was opened in; nothing
    // went under the new one.
    expect(editorDraftStash.take("daemon-a", "ws", "src/f.ts")).toBe("unsaved edit\n");
    expect(editorDraftStash.take("daemon-b", "ws", "src/f.ts")).toBeNull();
  });

  it("keeps the editor and its unsaved text when startup first learns the daemon's realm", async () => {
    const { render, FileView, nav, editorDraftStash } = await launch();
    // Startup has not learned the daemon yet: the realm is the "local" default.
    expect(nav.tabRealm()).toBe("local");
    const { host, area } = await openEditorAndEdit(render, FileView);

    // Startup's correction (index.ts, tabs already open): same daemon, now
    // with its real identity. Not a switch, so nothing may remount.
    nav.setTabRealm("client:devbox");
    expect(nav.tabRealm()).toBe("client:devbox");
    await Promise.resolve();

    const after = host.querySelector<HTMLTextAreaElement>("textarea.ws-file-editor-area");
    expect(after).toBe(area);
    expect(after!.value).toBe("unsaved edit\n");

    // And the draft belongs to the corrected realm from here on.
    dispose!();
    dispose = undefined;
    expect(editorDraftStash.take("local", "ws", "src/f.ts")).toBeNull();
    expect(editorDraftStash.take("client:devbox", "ws", "src/f.ts")).toBe("unsaved edit\n");
  });

  it("still remounts on a daemon switch that is the first realm assignment (startup never learned the realm)", async () => {
    const { render, FileView, nav, editorDraftStash } = await launch();
    // Startup failed before learning the daemon; a focus refresh still loaded
    // workspaces, and the user is editing under the "local" placeholder.
    expect(nav.tabRealm()).toBe("local");
    const { host, area } = await openEditorAndEdit(render, FileView);

    // Then they switch daemons (what clientsStore.activate/add/remove do), and
    // the new daemon restores a workspace with the same name.
    nav.deferTabRestore({ daemonSwitch: true });
    nav.restoreWorkspaceTabs("client:devbox", () => true);

    const fresh = await vi.waitFor(() => {
      const el = host.querySelector<HTMLTextAreaElement>("textarea.ws-file-editor-area");
      expect(el).toBeTruthy();
      expect(el).not.toBe(area);
      expect(el!.value).toBe("saved text\n");
      return el!;
    });
    expect(fresh.isConnected).toBe(true);
    // The old daemon's text stayed with the old daemon's editor.
    expect(editorDraftStash.take("local", "ws", "src/f.ts")).toBe("unsaved edit\n");
    expect(editorDraftStash.take("client:devbox", "ws", "src/f.ts")).toBeNull();
  });
});
