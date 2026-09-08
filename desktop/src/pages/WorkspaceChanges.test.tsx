// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "solid-js/web";

const send = vi.fn(async (request: { type: string }) => {
  if (request.type === "get_workspace_changes") {
    return {
      type: "workspace_changes",
      workspace: "demo",
      files: [
        {
          path: "src/main.ts",
          additions: 4,
          deletions: 1,
          staged: false,
          unstaged: true,
          untracked: false,
        },
      ],
    };
  }
  if (request.type === "get_recent_commits") {
    return { type: "recent_commits", workspace: "demo", log: "" };
  }
  if (request.type === "get_workspace_diff") {
    return { type: "workspace_diff", workspace: "demo", diff: "diff --git a/src/main.ts b/src/main.ts" };
  }
  throw new Error(`Unexpected request: ${request.type}`);
});

vi.mock("@/bridge/client", () => ({ send }));
vi.mock("@/store/actions", () => ({ actions: { revealPanel: vi.fn() } }));

const { default: ChangesTab } = await import("./WorkspaceChanges");
const { registerOpenFile } = await import("./openFileBridge");

let dispose: (() => void) | undefined;

function mount() {
  const host = document.createElement("div");
  document.body.append(host);
  dispose = render(() => <ChangesTab workspace="demo" />, host);
  return host;
}

afterEach(() => {
  dispose?.();
  dispose = undefined;
  document.body.innerHTML = "";
  send.mockClear();
});

describe("ChangesTab", () => {
  it("keeps the panel list-only", async () => {
    const host = mount();

    await vi.waitFor(() => expect(host.querySelector(".ws-change-row")).toBeTruthy());

    expect(host.querySelector(".ws-diff-view")).toBeNull();
    expect(send.mock.calls.some(([request]) => request.type === "get_workspace_diff")).toBe(false);
  });

  it("renders a changed file like a Files row with trailing line counts", async () => {
    const host = mount();

    const row = await vi.waitFor(() => {
      const element = host.querySelector<HTMLButtonElement>(".ws-change-row");
      expect(element).toBeTruthy();
      return element!;
    });

    expect(row.classList.contains("ws-file-row")).toBe(true);
    expect(row.querySelector("img.ws-material-icon.ws-file-kind-icon")).toBeTruthy();
    expect(row.querySelector(".ws-file-name")?.textContent).toBe("src/main.ts");
    expect(row.querySelector(".ws-file-summary-state")).toBeNull();
    expect(row.lastElementChild?.classList.contains("ws-file-summary-counts")).toBe(true);
    expect(row.lastElementChild?.textContent).toBe("+4-1");
  });

  it("opens a changed file in the center with the selected scope", async () => {
    const opened = vi.fn();
    registerOpenFile(opened);
    const host = mount();

    const row = await vi.waitFor(() => {
      const element = host.querySelector<HTMLButtonElement>(".ws-change-row");
      expect(element).toBeTruthy();
      return element!;
    });
    row.click();

    expect(opened).toHaveBeenCalledWith("demo", "src/main.ts", "all");
  });
});
