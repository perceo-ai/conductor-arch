// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "solid-js/web";

// A setup report that is COMPLETE (nothing blocks chat) but whose daemon is
// denied a protected folder. This is the ordinary first-run shape on macOS:
// gh and an agent are both ready, and ~/Documents is refused.
const report = {
  rows: [
    { name: "GitHub CLI", detail: "Ready.", state: "ready" as const, required: true },
    { name: "Coding agent", detail: "codex.", state: "ready" as const, required: true },
  ],
  feedback: "Setup is complete.",
  complete: true,
  file_access: [
    { root: "/Users/x/Documents", state: "denied" as const, detail: "denied", registered: false },
  ],
};

vi.mock("@/store", () => ({
  setupStore: {
    report: () => report,
    blocked: () => false,
    checking: () => false,
    recheck: vi.fn(async () => report),
  },
}));

vi.mock("@/bridge/client", () => ({
  remoteDaemon: { get: async () => ({ ok: true, address: null }), clear: vi.fn() },
  fileAccess: { openSettings: vi.fn(), revealDaemon: vi.fn(), restartDaemon: vi.fn() },
}));

const { default: SetupModal } = await import("./SetupModal");

let dispose: (() => void) | undefined;

afterEach(() => {
  dispose?.();
  dispose = undefined;
  document.body.innerHTML = "";
});

describe("SetupModal", () => {
  it("asks for file access even when nothing else blocks setup", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    dispose = render(() => <SetupModal />, host);

    await vi.waitFor(() =>
      expect(document.querySelector(".permission-card")).toBeTruthy(),
    );
    expect(document.querySelector(".permission-card")!.textContent).toContain(
      "/Users/x/Documents",
    );
  });

  // A denial does not block chat, so the gate it raises must be escapable —
  // otherwise a user who does not want to grant the permission cannot reach
  // the app at all.
  it("can be dismissed when only file access is outstanding", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    dispose = render(() => <SetupModal />, host);

    await vi.waitFor(() => expect(document.querySelector(".permission-card")).toBeTruthy());
    const dismiss = [...document.querySelectorAll("button")].find((b) =>
      b.textContent?.includes("Not now"),
    );
    expect(dismiss).toBeTruthy();

    dismiss!.click();

    await vi.waitFor(() => expect(document.querySelector(".setup-modal")).toBeNull());
  });
});
