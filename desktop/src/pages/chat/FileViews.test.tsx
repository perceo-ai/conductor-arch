// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "solid-js/web";

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

const { FileView } = await import("./FileViews");
const { nav } = await import("@/store/nav");
const { editorDraftStash } = await import("@/lib/editorDraftStash");

let dispose: (() => void) | undefined;

afterEach(() => {
  dispose?.();
  dispose = undefined;
  document.body.innerHTML = "";
  send.mockClear();
});

describe("FileEditor draft stash", () => {
  it("remounts the editor on a daemon switch, parking the old editor's draft under its own realm", async () => {
    // Opened while pointed at daemon-a.
    nav.restoreWorkspaceTabs("daemon-a", () => true);
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
});
