// @vitest-environment node
import { describe, expect, it, vi } from "vitest";

vi.mock("@/store/actions", () => ({ actions: { revealPanel: vi.fn() } }));
const { registerOpenFile, openFileInCenter, registerOpenCommit, openCommitInCenter } = await import("./openFileBridge");

describe("openFileBridge", () => {
  it("routes opens to the handler registered for that workspace", () => {
    const a = vi.fn();
    const b = vi.fn();
    const offA = registerOpenFile("ws-a", a);
    registerOpenFile("ws-b", b);

    openFileInCenter("ws-a", "src/x.ts", "all");
    openFileInCenter("ws-b", "src/y.ts");
    expect(a).toHaveBeenCalledWith("src/x.ts", "all");
    expect(b).toHaveBeenCalledWith("src/y.ts", undefined);

    // Deregistering one workspace leaves the other answering.
    offA();
    openFileInCenter("ws-a", "src/x.ts");
    expect(a).toHaveBeenCalledTimes(1);
    openFileInCenter("ws-b", "src/z.ts");
    expect(b).toHaveBeenCalledTimes(2);
  });

  it("a stale deregistration does not remove a newer handler", () => {
    const old = vi.fn();
    const offOld = registerOpenCommit("ws", old);
    const fresh = vi.fn();
    registerOpenCommit("ws", fresh);
    offOld();
    openCommitInCenter("ws", "abc123");
    expect(fresh).toHaveBeenCalledWith("abc123");
    expect(old).not.toHaveBeenCalled();
  });
});
