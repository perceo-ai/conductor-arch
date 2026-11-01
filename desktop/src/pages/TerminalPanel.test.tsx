// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "solid-js/web";

const terminalConstructor = vi.fn();
const expectedOptions = {
  fontFamily: "Iosevka, monospace",
  fontSize: 16,
  scrollback: 9000,
  theme: { background: "#010101", foreground: "#f0f0f0" },
};

vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    rows = 24;
    cols = 80;
    constructor(options: unknown) { terminalConstructor(options); }
    loadAddon() {}
    open() {}
    onData() {}
    onResize() {}
    dispose() {}
    write() {}
    reset() {}
  },
}));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class { fit() {} } }));
vi.mock("@/bridge/client", () => ({ send: vi.fn(async () => ({ type: "ack" })) }));
vi.mock("@/store", () => ({
  appearanceStore: { terminalOptions: () => expectedOptions },
  terminalStore: { sessionId: () => undefined, screen: () => "" },
}));

class ResizeObserverStub {
  observe() {}
  disconnect() {}
}

let dispose: (() => void) | undefined;

afterEach(() => {
  dispose?.();
  dispose = undefined;
  document.body.innerHTML = "";
  terminalConstructor.mockClear();
  vi.unstubAllGlobals();
});

describe("TerminalPanel appearance", () => {
  it("passes durable font, size, scrollback, and colors to xterm", async () => {
    vi.stubGlobal("ResizeObserver", ResizeObserverStub);
    vi.stubGlobal("requestAnimationFrame", () => 1);
    vi.stubGlobal("cancelAnimationFrame", () => {});
    const { default: TerminalPanel } = await import("./TerminalPanel");
    const host = document.createElement("div");
    document.body.append(host);

    dispose = render(() => <TerminalPanel workspace="demo" tabId="shell-1" />, host);

    expect(terminalConstructor).toHaveBeenCalledWith({
      ...expectedOptions,
      cursorBlink: true,
      convertEol: true,
    });
  });
});
