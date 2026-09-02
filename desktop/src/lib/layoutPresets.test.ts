import { describe, expect, it } from "vitest";
import { sanitizeLayout, visiblePanelIds } from "./layout";
import { BUILTIN_PRESETS, builtinPreset, forkBuiltinPreset, mergePresets, presetAfterEdit, type LayoutPreset } from "./layoutPresets";

describe("layout presets", () => {
  it("ships Code as the same tree as the default fallback layout", () => {
    const code = builtinPreset("code")!;
    expect(code.id).toBe("code");
    expect(code.name).toBe("Code");
    expect(code.builtin).toBe(true);
    expect(code.layout.version).toBe(2);
    expect(visiblePanelIds(code.layout)).toEqual(["chat", "pr", "summary", "files", "changes", "checks"]);
  });

  it("ships the approved Wide, Review, and Watch arrangements", () => {
    expect(BUILTIN_PRESETS.map((preset) => preset.id)).toEqual(["code", "wide", "review", "watch"]);
    expect(visiblePanelIds(builtinPreset("wide")!.layout)).toEqual(["chat", "summary", "files", "changes", "checks"]);
    expect(visiblePanelIds(builtinPreset("review")!.layout)).toEqual(["changes", "files", "pr", "chat", "checks"]);
    expect(visiblePanelIds(builtinPreset("watch")!.layout)).toEqual(["chat", "checks", "processes", "terminal"]);
  });

  it("merges built-ins before users, filters reserved ids case-insensitively, and sorts users by name", () => {
    const reserved: LayoutPreset = { ...BUILTIN_PRESETS[0], id: "Code", name: "Override", builtin: false };
    const zebra: LayoutPreset = { ...forkBuiltinPreset("code"), id: "custom-zebra", name: "zebra" };
    const alpha: LayoutPreset = { ...forkBuiltinPreset("code"), id: "custom-alpha", name: "Alpha" };
    expect(mergePresets([zebra, reserved, alpha]).map((preset) => preset.name)).toEqual(["Code", "Wide", "Review", "Watch", "Alpha", "zebra"]);
  });

  it("freezes built-in sources and gives callers independent built-in clones", () => {
    expect(Object.isFrozen(BUILTIN_PRESETS[0].layout.root)).toBe(true);
    const first = builtinPreset("code")!;
    if (first.layout.root.type === "split") first.layout.root.ratio = 0.99;
    expect((builtinPreset("code")!.layout.root as { ratio?: number }).ratio).not.toBe(0.99);
  });

  it("forks built-ins into independently editable custom presets", () => {
    const fork = forkBuiltinPreset("code");
    expect(fork).toMatchObject({ name: "Code (edited)", builtin: false });
    expect(fork.id).toMatch(/^custom-/);
    if (fork.layout.root.type === "split") fork.layout.root.ratio = 0.99;
    expect((builtinPreset("code")!.layout.root as { ratio?: number }).ratio).not.toBe(0.99);
  });

  it("edits a built-in by forking and leaves a custom preset in place", () => {
    expect(presetAfterEdit(BUILTIN_PRESETS[0]).id).toMatch(/^custom-/);
    const custom = forkBuiltinPreset("wide");
    expect(presetAfterEdit(custom)).toBe(custom);
  });
});

describe("built-in presets", () => {
  it("are all valid v2 trees that survive sanitising unchanged", () => {
    for (const preset of BUILTIN_PRESETS) {
      expect(preset.layout.version).toBe(2);
      expect(sanitizeLayout(structuredClone(preset.layout))).toEqual(preset.layout);
    }
  });

  it("every preset shows chat and hides nothing it also shows", () => {
    for (const preset of BUILTIN_PRESETS) {
      const visible = visiblePanelIds(preset.layout);
      expect(visible).toContain("chat");
      for (const hidden of preset.hidden) expect(visible).not.toContain(hidden);
    }
  });
});
