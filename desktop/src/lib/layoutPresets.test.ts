import { describe, expect, it } from "vitest";
import { BUILTIN_PRESETS, builtinPreset, forkBuiltinPreset, mergePresets, presetAfterEdit, type LayoutPreset } from "./layoutPresets";

describe("layout presets", () => {
  it("ships Code as exact current shell layout", () => {
    expect(builtinPreset("code")).toMatchObject({
      id: "code",
      name: "Code",
      builtin: true,
      layout: {
        regions: {
          center: { panels: ["chat"] },
          right: { strips: ["pr"], panels: ["summary", "files", "changes", "checks"], docks: ["terminal"], active: 2 },
          left: { panels: [], strips: [], docks: [] },
          bottom: { panels: [], strips: [], docks: [] },
        },
      },
      hidden: ["todos", "checkpoints", "processes", "timeline", "context"],
    });
  });

  it("ships the approved Wide, Review, and Watch arrangements", () => {
    expect(BUILTIN_PRESETS.map((preset) => preset.id)).toEqual(["code", "wide", "review", "watch"]);
    expect(builtinPreset("wide")?.layout.regions.left.panels).toEqual(["files"]);
    expect(builtinPreset("wide")?.layout.regions.bottom.docks).toEqual(["terminal"]);
    expect(builtinPreset("review")?.layout.regions.center.panels).toEqual(["changes"]);
    expect(builtinPreset("watch")?.layout.regions.center.docks).toEqual(["terminal"]);
    expect(builtinPreset("watch")?.layout.regions.bottom.panels).toEqual(["chat"]);
  });

  it("merges built-ins before users, filters reserved ids case-insensitively, and sorts users by name", () => {
    const reserved: LayoutPreset = { ...BUILTIN_PRESETS[0], id: "Code", name: "Override", builtin: false };
    const zebra: LayoutPreset = { ...forkBuiltinPreset("code"), id: "custom-zebra", name: "zebra" };
    const alpha: LayoutPreset = { ...forkBuiltinPreset("code"), id: "custom-alpha", name: "Alpha" };
    expect(mergePresets([zebra, reserved, alpha]).map((preset) => preset.name)).toEqual(["Code", "Wide", "Review", "Watch", "Alpha", "zebra"]);
  });

  it("freezes built-in sources and gives callers independent built-in clones", () => {
    expect(Object.isFrozen(BUILTIN_PRESETS[0].layout.regions.center.panels)).toBe(true);
    const first = builtinPreset("code")!;
    first.layout.regions.center.panels.push("files");
    expect(builtinPreset("code")!.layout.regions.center.panels).toEqual(["chat"]);
  });

  it("forks built-ins into independently editable custom presets", () => {
    const fork = forkBuiltinPreset("code");
    expect(fork).toMatchObject({ name: "Code (edited)", builtin: false });
    expect(fork.id).toMatch(/^custom-/);
    fork.layout.regions.right.panels.pop();
    expect(builtinPreset("code")?.layout.regions.right.panels).toHaveLength(4);
  });

  it("edits a built-in by forking and leaves a custom preset in place", () => {
    expect(presetAfterEdit(BUILTIN_PRESETS[0]).id).toMatch(/^custom-/);
    const custom = forkBuiltinPreset("wide");
    expect(presetAfterEdit(custom)).toBe(custom);
  });
});
