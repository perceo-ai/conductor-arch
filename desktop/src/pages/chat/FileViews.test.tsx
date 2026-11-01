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
  it("parks unsaved text under the realm the editor opened in, even if the realm changes before unmount", async () => {
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

    // The realm moves on (a daemon switch) while this editor is still mounted;
    // when the workspace name matches on both daemons the chat surface can
    // stay up across the swap.
    nav.restoreWorkspaceTabs("daemon-b", () => true);
    expect(nav.tabRealm()).toBe("daemon-b");

    dispose();
    dispose = undefined;

    expect(editorDraftStash.take("daemon-b", "ws", "src/f.ts")).toBeNull();
    expect(editorDraftStash.take("daemon-a", "ws", "src/f.ts")).toBe("unsaved edit\n");
  });
});
