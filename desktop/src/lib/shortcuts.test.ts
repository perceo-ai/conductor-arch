// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  DEFAULT_SHORTCUTS,
  shortcutHelp,
  parseKeybindingOverrides,
  resolveShortcut,
  SHORTCUT_HELP,
  type KeyEventLike,
} from "./shortcuts";

const ev = (key: string, mod = false, shift = false, alt = false): KeyEventLike => ({
  key,
  ctrlKey: mod,
  metaKey: false,
  shiftKey: shift,
  altKey: alt,
});

describe("resolveShortcut", () => {
  it("requires the primary modifier for most actions", () => {
    expect(resolveShortcut(ev("b"))).toBeNull();
    expect(resolveShortcut(ev("b", true))).toBe("toggle-sidebar");
  });

  it("does not treat Space as a disabled empty shortcut", () => {
    expect(resolveShortcut(ev(" "))).toBeNull();
    expect(resolveShortcut(ev("Space"))).toBeNull();
  });

  it("maps nav and page shortcuts", () => {
    expect(resolveShortcut(ev("[", true))).toBe("nav-back");
    expect(resolveShortcut(ev("]", true))).toBe("nav-forward");
    expect(resolveShortcut(ev("k", true))).toBe("open-palette");
    expect(resolveShortcut(ev("p", true))).toBe("quick-open");
    expect(resolveShortcut(ev("1", true))).toBe("switch-workspace-1");
    expect(resolveShortcut(ev("9", true))).toBe("switch-workspace-9");
    expect(resolveShortcut(ev(",", true))).toBe("goto-settings");
  });

  it("honours Cmd (metaKey) as well as Ctrl", () => {
    expect(resolveShortcut({ key: "b", ctrlKey: false, metaKey: true, shiftKey: false })).toBe(
      "toggle-sidebar",
    );
  });

  it("quick-opens help with the primary modifier", () => {
    expect(resolveShortcut(ev("/", true))).toBe("show-help");
    expect(resolveShortcut(ev("?"))).toBeNull();
  });

  it("returns null for unmapped keys", () => {
    expect(resolveShortcut(ev("z", true))).toBeNull();
  });

  it("maps conductor mod+shift workflow chords (uppercase key)", () => {
    expect(resolveShortcut(ev("N", true, true))).toBe("new-workspace");
    expect(resolveShortcut(ev("D", true, true))).toBe("show-changes");
    expect(resolveShortcut(ev("P", true, true))).toBe("create-pr");
    expect(resolveShortcut(ev("A", true, true))).toBe("archive-workspace");
    expect(resolveShortcut(ev("M", true, true))).toBe("merge-pr");
    expect(resolveShortcut(ev("R", true, true))).toBe("start-review");
  });

  it("maps keyboard-first Conductor parity shortcuts", () => {
    expect(resolveShortcut(ev("t", true, false, true))).toBe("toggle-theme");
    expect(resolveShortcut(ev("a", true, false, true))).toBe("add-project");
    expect(resolveShortcut(ev("b", true, false, true))).toBe("toggle-right-panel");
    expect(resolveShortcut(ev("j", true))).toBe("toggle-terminal");
    expect(resolveShortcut(ev("l", true))).toBe("focus-composer");
    expect(resolveShortcut(ev("f", true))).toBe("focus-search");
    expect(resolveShortcut(ev("]", true, true))).toBe("next-panel");
    expect(resolveShortcut(ev("[", true, true))).toBe("prev-panel");
    expect(resolveShortcut(ev("ArrowDown", true, false, true))).toBe("next-workspace");
    expect(resolveShortcut(ev("ArrowUp", true, false, true))).toBe("prev-workspace");
    expect(resolveShortcut(ev("O", true))).toBe("open-in-app");
    expect(resolveShortcut(ev("O", true, true))).toBe("open-menu");
    expect(resolveShortcut(ev("C", true, true))).toBe("copy-link");
    expect(resolveShortcut(ev("F", true, false, true))).toBe("show-files");
    expect(resolveShortcut(ev("C", true, false, true))).toBe("show-uncommitted");
    expect(resolveShortcut(ev("C", true, true, true))).toBe("show-checks");
    expect(resolveShortcut(ev("N", true, false, true))).toBe("show-summary");
  });

  it("maps surface action shortcuts through the customizable resolver", () => {
    expect(resolveShortcut(ev("s", true))).toBe("save");
    expect(resolveShortcut(ev("Enter", true))).toBe("send-immediate");
    expect(resolveShortcut(ev("t", true))).toBe("new-chat");
    expect(resolveShortcut(ev("Tab", true, true))).toBe("toggle-plan-mode");
    expect(resolveShortcut(ev("Enter", true, true))).toBe("approve-plan");
  });

  it("lets custom bindings override defaults and supports legacy aliases", () => {
    const shortcuts = parseKeybindingOverrides(
      "palette=ctrl+p,focus=ctrl+shift+f,changes=cmd+shift+x,send=cmd+enter",
      DEFAULT_SHORTCUTS,
    );
    expect(resolveShortcut(ev("k", true), shortcuts)).toBeNull();
    expect(resolveShortcut(ev("p", true), shortcuts)).toBe("open-palette");
    expect(resolveShortcut(ev("F", true, true), shortcuts)).toBe("focus-composer");
    expect(resolveShortcut({ key: "X", ctrlKey: false, metaKey: true, shiftKey: true }, shortcuts)).toBe(
      "show-changes",
    );
    expect(resolveShortcut({ key: "Enter", ctrlKey: false, metaKey: true, shiftKey: false }, shortcuts)).toBe(
      "send-immediate",
    );
  });

  it("rejects custom shortcuts without the primary modifier", () => {
    const shortcuts = parseKeybindingOverrides(
      "dashboard=space; files=alt+f; plan=shift+tab; settings=ctrl+.",
      DEFAULT_SHORTCUTS,
    );
    expect(resolveShortcut(ev(" "))).toBeNull();
    expect(resolveShortcut(ev("F", false, false, true), shortcuts)).toBeNull();
    expect(resolveShortcut(ev("Tab", false, true), shortcuts)).toBeNull();
    expect(resolveShortcut(ev(".", true), shortcuts)).toBe("goto-settings");
  });

  it("keeps invalid custom bindings out of the active map", () => {
    const shortcuts = parseKeybindingOverrides(
      "palette=ctrl+p,bogus=ctrl+b,history=nope,settings=ctrl+,",
      DEFAULT_SHORTCUTS,
    );
    expect(resolveShortcut(ev("p", true), shortcuts)).toBe("open-palette");
    expect(resolveShortcut(ev("b", true), shortcuts)).toBe("toggle-sidebar");
    expect(resolveShortcut(ev(",", true), shortcuts)).toBe("goto-settings");
  });

  it("allows comma as a customizable key", () => {
    const shortcuts = parseKeybindingOverrides("palette=ctrl+,; settings=ctrl+.", DEFAULT_SHORTCUTS);
    expect(resolveShortcut(ev(",", true), shortcuts)).toBe("open-palette");
    expect(resolveShortcut(ev(".", true), shortcuts)).toBe("goto-settings");
  });

  it("keeps alias rows independent when customizing an action with multiple defaults", () => {
    const shortcuts = parseKeybindingOverrides("settings=ctrl+.", DEFAULT_SHORTCUTS);
    expect(resolveShortcut(ev(".", true), shortcuts)).toBe("goto-settings");
    expect(resolveShortcut(ev(",", true), shortcuts)).toBe("goto-settings");
  });

  it("lets a custom binding claim a default chord from another action", () => {
    const shortcuts = parseKeybindingOverrides("sidebar=ctrl+k", DEFAULT_SHORTCUTS);
    expect(resolveShortcut(ev("k", true), shortcuts)).toBe("toggle-sidebar");
  });

  it("help table is non-empty and well-formed", () => {
    expect(SHORTCUT_HELP.length).toBeGreaterThan(0);
    expect(SHORTCUT_HELP.every((r) => r.keys && r.label)).toBe(true);
  });

  it("renders help from the active keymap", () => {
    const shortcuts = parseKeybindingOverrides("palette=ctrl+p", DEFAULT_SHORTCUTS);
    expect(shortcutHelp(shortcuts).find((r) => r.label === "Command palette")?.keys).toBe("⌘/Ctrl P");
  });
});
