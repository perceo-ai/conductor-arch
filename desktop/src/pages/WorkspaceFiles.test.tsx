// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "solid-js/web";

const openContextMenu = vi.fn();
const openExternal = vi.fn(async () => ({ ok: true }));
const openWorkspaceApp = vi.fn(async () => ({ ok: true }));

vi.mock("@/bridge/client", () => ({
  listWorkspaceFiles: vi.fn(async () => ({ ok: true, files: ["src/App.tsx", "README.md"] })),
  send: vi.fn(async () => ({ type: "workspace_files", files: ["src/App.tsx", "README.md"] })),
  openExternal,
  openWorkspaceApp,
}));
vi.mock("@/components/ContextMenu", () => ({ openContextMenu, openContextMenuFromKeyboard: vi.fn() }));
vi.mock("@/store", () => ({ workspacesStore: { row: () => ({ path: "/ws/feature" }) } }));
vi.mock("@/store/toasts", () => ({ toastsStore: { error: vi.fn() } }));
vi.mock("./openFileBridge", () => ({ openFileInCenter: vi.fn() }));

const { default: WorkspaceFiles } = await import("./WorkspaceFiles");

let dispose: (() => void) | undefined;

afterEach(() => {
  dispose?.();
  dispose = undefined;
  document.body.innerHTML = "";
  openContextMenu.mockClear();
});

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("WorkspaceFiles context menu", () => {
  it("offers open-with actions against the worktree path of the clicked file", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    dispose = render(() => <WorkspaceFiles workspace="feature" />, host);
    await settle();
    // Collapsed by default — expand `src` to reach the file row.
    const dir = host.querySelector(".ws-dir-row") as HTMLElement;
    dir.click();
    await settle();
    const file = host.querySelector(".ws-file-row") as HTMLElement;
    expect(file.textContent).toContain("App.tsx");
    file.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));
    const items = openContextMenu.mock.calls.at(-1)?.[1] as { label: string; run: () => void }[];
    expect(items[0].label).toBe("Open in default app");
    items[0].run();
    expect(openExternal).toHaveBeenCalledWith("/ws/feature/src/App.tsx");
    items.find((item) => item.label === "Open in VS Code")?.run();
    expect(openWorkspaceApp).toHaveBeenCalledWith({ rootPath: "/ws/feature/src/App.tsx", appId: "vscode" });
  });

  it("offers the folder wording on a directory row", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    dispose = render(() => <WorkspaceFiles workspace="feature" />, host);
    await settle();
    const dir = host.querySelector(".ws-dir-row") as HTMLElement;
    dir.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));
    const items = openContextMenu.mock.calls.at(-1)?.[1] as { label: string; run: () => void }[];
    expect(items[0].label).not.toBe("Open in default app");
    items[0].run();
    expect(openExternal).toHaveBeenCalledWith("/ws/feature/src");
  });
});
