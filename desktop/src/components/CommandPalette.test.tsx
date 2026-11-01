// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "solid-js/web";

import CommandPalette from "./CommandPalette";
import { appearanceStore } from "@/store/appearance";
import { toastsStore } from "@/store/toasts";

const send = vi.hoisted(() => vi.fn());
vi.mock("@/bridge/client", () => ({ send }));

let dispose: (() => void) | undefined;

afterEach(() => {
  dispose?.();
  dispose = undefined;
  document.body.innerHTML = "";
});

beforeEach(async () => {
  send.mockReset();
  send.mockImplementation(async (request) => {
    if (request.type === "get_settings_source") {
      return { type: "settings_source", scope: "global", layer: "global", toml: "" };
    }
    if (request.type === "save_settings") {
      return { type: "settings_saved", scope: "global", layer: "global" };
    }
    if (request.type === "get_settings") {
      return {
        type: "settings",
        scope: "global",
        toml: '[customization.view]\ntheme = "dark"\n[customization.view.colors]\naccent = "#5b8def"\n',
      };
    }
    return { type: "workspace_files", workspace: "", files: [] };
  });
  await appearanceStore.refresh();
  send.mockClear();
});

describe("CommandPalette keyboard focus", () => {
  it("traps focus while open and restores the exact prior control on close", async () => {
    const background = document.createElement("div");
    background.className = "window-content";
    const opener = document.createElement("button");
    opener.textContent = "Open commands";
    background.append(opener);
    document.body.append(background);
    const host = document.createElement("div");
    document.body.append(host);
    dispose = render(() => <CommandPalette />, host);
    opener.focus();

    window.dispatchEvent(
      new KeyboardEvent("keydown", { key: "k", ctrlKey: true, bubbles: true, cancelable: true }),
    );
    await Promise.resolve();

    const dialog = document.querySelector<HTMLElement>("[role='dialog'][aria-modal='true']");
    const input = dialog?.querySelector<HTMLInputElement>("[role='combobox']");
    expect(dialog).not.toBeNull();
    expect(document.activeElement).toBe(input);
    expect(background.hasAttribute("inert")).toBe(true);

    const tab = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
    input?.dispatchEvent(tab);
    expect(tab.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(input);

    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await Promise.resolve();

    expect(document.querySelector("[role='dialog']")).toBeNull();
    expect(background.hasAttribute("inert")).toBe(false);
    expect(document.activeElement).toBe(opener);
  });

  it("moves focus to the new page surface when the opener was removed by navigation", async () => {
    const background = document.createElement("div");
    background.className = "window-content";
    const opener = document.createElement("button");
    const destination = document.createElement("main");
    destination.dataset.focusTarget = "workspace-main";
    destination.tabIndex = -1;
    background.append(opener, destination);
    document.body.append(background);
    const host = document.createElement("div");
    document.body.append(host);
    dispose = render(() => <CommandPalette />, host);
    opener.focus();

    window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true }));
    await Promise.resolve();
    opener.remove();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    await Promise.resolve();

    expect(document.activeElement).toBe(destination);
  });
});

describe("CommandPalette appearance", () => {
  it("persists theme changes through app-shared settings", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    dispose = render(() => <CommandPalette />, host);
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", ctrlKey: true, bubbles: true }));
    await Promise.resolve();
    const input = document.querySelector<HTMLInputElement>("[role='combobox']")!;
    input.value = "Switch to";
    input.dispatchEvent(new InputEvent("input", { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));

    await vi.waitFor(() => expect(send.mock.calls.some(([request]) => request.type === "save_settings")).toBe(true));
    const saved = send.mock.calls.map(([request]) => request).find((request) => request.type === "save_settings");
    expect(saved.toml).toContain('theme = "light"');
  });

  it("persists accent cycling through the same color keys the editor uses", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    dispose = render(() => <CommandPalette />, host);
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", ctrlKey: true, bubbles: true }));
    await Promise.resolve();
    const input = document.querySelector<HTMLInputElement>("[role='combobox']")!;
    input.value = "Cycle accent";
    input.dispatchEvent(new InputEvent("input", { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));

    await vi.waitFor(() => expect(send.mock.calls.some(([request]) => request.type === "save_settings")).toBe(true));
    const saved = send.mock.calls.map(([request]) => request).find((request) => request.type === "save_settings");
    expect(saved.toml).toContain('[customization.view.colors]');
    expect(saved.toml).toContain('accent = "#3fb27f"');
    expect(saved.toml).toContain('accent_color = "#3fb27f"');
  });

  it("toggles system-dark to a visibly different light theme", async () => {
    vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: true, addEventListener: vi.fn() })));
    send.mockImplementation(async (request) => {
      if (request.type === "get_settings") {
        return { type: "settings", scope: "global", toml: '[customization.view]\ntheme = "system"\n' };
      }
      if (request.type === "get_settings_source") {
        return { type: "settings_source", scope: "global", layer: "global", toml: "" };
      }
      if (request.type === "save_settings") {
        return { type: "settings_saved", scope: "global", layer: "global" };
      }
      return { type: "workspace_files", workspace: "", files: [] };
    });
    await appearanceStore.refresh();
    send.mockClear();
    const host = document.createElement("div");
    document.body.append(host);
    dispose = render(() => <CommandPalette />, host);
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", ctrlKey: true, bubbles: true }));
    await Promise.resolve();
    const input = document.querySelector<HTMLInputElement>("[role='combobox']")!;
    input.value = "Switch to";
    input.dispatchEvent(new InputEvent("input", { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));

    await vi.waitFor(() => expect(send.mock.calls.some(([request]) => request.type === "save_settings")).toBe(true));
    const saved = send.mock.calls.map(([request]) => request).find((request) => request.type === "save_settings");
    expect(saved.toml).toContain('theme = "light"');
    vi.unstubAllGlobals();
  });

  it("surfaces durable appearance failures instead of rejecting unhandled", async () => {
    const error = vi.spyOn(toastsStore, "error");
    send.mockImplementation(async (request) => {
      if (request.type === "get_settings_source") throw new Error("daemon unavailable");
      return { type: "workspace_files", workspace: "", files: [] };
    });
    const host = document.createElement("div");
    document.body.append(host);
    dispose = render(() => <CommandPalette />, host);
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", ctrlKey: true, bubbles: true }));
    await Promise.resolve();
    const input = document.querySelector<HTMLInputElement>("[role='combobox']")!;
    input.value = "Switch to";
    input.dispatchEvent(new InputEvent("input", { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));

    await vi.waitFor(() => expect(error).toHaveBeenCalledWith("Could not update appearance: daemon unavailable"));
  });
});
