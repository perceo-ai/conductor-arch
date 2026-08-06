// @vitest-environment node
import { describe, expect, it } from "vitest";
import { resolveShortcut, SHORTCUT_HELP, type KeyEventLike } from "./shortcuts";

const ev = (key: string, mod = false, shift = false): KeyEventLike => ({
  key,
  ctrlKey: mod,
  metaKey: false,
  shiftKey: shift,
});

describe("resolveShortcut", () => {
  it("requires the primary modifier for most actions", () => {
    expect(resolveShortcut(ev("b"))).toBeNull();
    expect(resolveShortcut(ev("b", true))).toBe("toggle-sidebar");
  });

  it("maps nav and page shortcuts", () => {
    expect(resolveShortcut(ev("[", true))).toBe("nav-back");
    expect(resolveShortcut(ev("]", true))).toBe("nav-forward");
    expect(resolveShortcut(ev("k", true))).toBe("open-palette");
    expect(resolveShortcut(ev("1", true))).toBe("goto-dashboard");
    expect(resolveShortcut(ev("4", true))).toBe("goto-settings");
    expect(resolveShortcut(ev(",", true))).toBe("goto-settings");
  });

  it("honours Cmd (metaKey) as well as Ctrl", () => {
    expect(resolveShortcut({ key: "b", ctrlKey: false, metaKey: true, shiftKey: false })).toBe(
      "toggle-sidebar",
    );
  });

  it("shows help on ? without a modifier", () => {
    expect(resolveShortcut(ev("?"))).toBe("show-help");
  });

  it("returns null for unmapped keys", () => {
    expect(resolveShortcut(ev("z", true))).toBeNull();
  });

  it("maps conductor mod+shift workflow chords (uppercase key)", () => {
    expect(resolveShortcut(ev("N", true, true))).toBe("new-workspace");
    expect(resolveShortcut(ev("D", true, true))).toBe("show-changes");
    expect(resolveShortcut(ev("P", true, true))).toBe("create-pr");
    // mod+shift with an unmapped letter is null (doesn't fall through to plain map)
    expect(resolveShortcut(ev("B", true, true))).toBeNull();
  });

  it("help table is non-empty and well-formed", () => {
    expect(SHORTCUT_HELP.length).toBeGreaterThan(0);
    expect(SHORTCUT_HELP.every((r) => r.keys && r.label)).toBe(true);
  });
});
