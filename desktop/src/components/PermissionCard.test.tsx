// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "solid-js/web";

const openSettings = vi.fn(async () => ({ ok: true }));
const revealDaemon = vi.fn(async () => ({ ok: true }));
const restartDaemon = vi.fn(async () => ({ ok: true }));

vi.mock("@/bridge/client", () => ({
  fileAccess: { openSettings, revealDaemon, restartDaemon },
}));

const { PermissionCard, isPermissionError } = await import("./PermissionCard");

const denied = [
  { root: "/Users/x/Documents", state: "denied" as const, detail: "d", registered: true },
];

let dispose: (() => void) | undefined;

function mount(remoteAddress: string | null) {
  const host = document.createElement("div");
  document.body.append(host);
  dispose = render(
    () => <PermissionCard probes={denied} remoteAddress={remoteAddress} />,
    host,
  );
  return host;
}

afterEach(() => {
  dispose?.();
  dispose = undefined;
  document.body.innerHTML = "";
  openSettings.mockClear();
});

function button(host: HTMLElement, label: string): HTMLButtonElement | undefined {
  return [...host.querySelectorAll("button")].find((el) =>
    el.textContent?.includes(label),
  ) as HTMLButtonElement | undefined;
}

describe("PermissionCard", () => {
  it("lists every denied root", () => {
    const host = mount(null);

    expect(host.querySelector(".permission-roots")?.textContent).toContain(
      "/Users/x/Documents",
    );
  });

  it("opens settings when asked", () => {
    const host = mount(null);

    button(host, "Open Settings")!.click();

    expect(openSettings).toHaveBeenCalled();
  });

  it("offers no local buttons for a remote daemon", () => {
    const host = mount("server:7420");

    expect(button(host, "Open Settings")).toBeUndefined();
    expect(host.textContent).toContain("server:7420");
  });

  it("recognises the daemon's permission error", () => {
    expect(
      isPermissionError(
        "macOS is denying the archcar daemon access to /Users/x/Documents/repo. Grant Full Disk Access to the archcar binary, then restart the daemon.",
      ),
    ).toBe(true);
    expect(isPermissionError("/tmp/x is not a Git repository")).toBe(false);
  });
});
