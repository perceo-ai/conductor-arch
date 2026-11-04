import { describe, expect, it, vi } from "vitest";

const openExternal = vi.fn(async () => ({ ok: true }));
const openWorkspaceApp = vi.fn(async () => ({ ok: true }));
const error = vi.fn();

vi.mock("@/bridge/client", () => ({ openExternal, openWorkspaceApp }));
vi.mock("@/store/toasts", () => ({ toastsStore: { error } }));

const { openWithItems, workspaceFilePath, workspaceOpenRoot } = await import("./openWith");

describe("workspaceFilePath", () => {
  it("joins a worktree root with a relative path", () => {
    expect(workspaceFilePath("/ws/feature", "desktop/src/App.tsx")).toBe("/ws/feature/desktop/src/App.tsx");
  });

  it("does not double up separators", () => {
    expect(workspaceFilePath("/ws/feature/", "/desktop/App.tsx")).toBe("/ws/feature/desktop/App.tsx");
  });

  it("has no path without a root", () => {
    expect(workspaceFilePath(undefined, "a.ts")).toBeNull();
    expect(workspaceFilePath("/ws", "")).toBeNull();
  });
});

describe("workspaceOpenRoot", () => {
  it("prefers the worktree over the project checkout", () => {
    expect(workspaceOpenRoot("/ws/feature", "/code/repo")).toBe("/ws/feature");
  });

  it("falls back to the project checkout only when the worktree path is unknown", () => {
    expect(workspaceOpenRoot(undefined, "/code/repo")).toBe("/code/repo");
    expect(workspaceOpenRoot("", "/code/repo")).toBe("/code/repo");
    expect(workspaceOpenRoot(undefined, undefined)).toBeUndefined();
  });
});

describe("openWithItems", () => {
  it("offers the OS default plus every launchable editor", () => {
    const labels = openWithItems("/ws/feature", "folder").map((item) => item.label);
    expect(labels.slice(1)).toEqual(["Open in Cursor", "Open in VS Code"]);
    expect(labels[0]).toMatch(/^Open in /);
  });

  it("words the default entry for a file, not a folder", () => {
    expect(openWithItems("/ws/feature/a.ts", "file")[0].label).toBe("Open in default app");
  });

  it("hands the exact path to the shell and to the editor launcher", () => {
    const items = openWithItems("/ws/feature/a.ts", "file");
    items[0].run();
    items[1].run();
    expect(openExternal).toHaveBeenCalledWith("/ws/feature/a.ts");
    expect(openWorkspaceApp).toHaveBeenCalledWith({ rootPath: "/ws/feature/a.ts", appId: "cursor" });
  });

  it("has nothing to offer for an empty path", () => {
    expect(openWithItems("")).toEqual([]);
  });
});
