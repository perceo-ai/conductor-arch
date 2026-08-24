// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ArchcarRequest, ArchcarResponse, LayoutPresetRecord } from "@/bridge/protocol";

const send = vi.fn<(request: ArchcarRequest) => Promise<ArchcarResponse>>();
vi.mock("@/bridge/client", () => ({ send }));

function record(id: string, name: string, layout: unknown, hidden: unknown = []): LayoutPresetRecord {
  return {
    id,
    name,
    builtin: ["code", "wide", "review", "watch"].includes(id),
    layout_json: typeof layout === "string" ? layout : JSON.stringify(layout),
    hidden_json: JSON.stringify(hidden),
    created_at: "1",
    updated_at: "1",
  };
}

async function codeLayout() {
  const { builtinPreset } = await import("@/lib/layoutPresets");
  return builtinPreset("code")!.layout;
}

function responses(records: LayoutPresetRecord[], defaultId?: string) {
  send.mockImplementation(async (request) => {
    if (request.type === "list_layout_presets") return { type: "layout_presets", presets: records };
    if (request.type === "get_settings") {
      return {
        type: "settings",
        scope: request.repository ?? "global",
        toml: defaultId
          ? `[customization.view]\ndefault_layout_preset = "${defaultId}"\n`
          : "[customization.view]\ntheme = \"dark\"\n",
      };
    }
    if (request.type === "save_layout_preset") return { type: "layout_preset_saved", preset: request.preset };
    return { type: "ack" };
  });
}

describe("layoutPresetsStore", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.useRealTimers();
    send.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("loads built-ins first, sanitizes remote users, and restores the local active id", async () => {
    const unknown = vi.spyOn(console, "warn").mockImplementation(() => {});
    const layout = await codeLayout();
    layout.regions.right.panels.push("future-panel");
    responses([record("custom-two", "Zeta", layout), record("code", "Server Code", layout)]);
    const { prefsStore } = await import("./prefs");
    prefsStore.setActivePresetId("custom-two");
    const { layoutPresetsStore } = await import("./layoutPresets");

    await layoutPresetsStore.load("demo");

    expect(layoutPresetsStore.presets().map((preset) => preset.name)).toEqual([
      "Code",
      "Wide",
      "Review",
      "Watch",
      "Zeta",
    ]);
    expect(layoutPresetsStore.activeId()).toBe("custom-two");
    expect(layoutPresetsStore.activePreset()?.layout.regions.right.panels).not.toContain("future-panel");
    expect(unknown).toHaveBeenCalledOnce();
  });

  it("falls back once for invalid JSON and chooses project default before Code", async () => {
    responses([record("broken", "Broken", "{"), record("custom-default", "Default", await codeLayout())], "custom-default");
    const { prefsStore } = await import("./prefs");
    prefsStore.setActivePresetId("missing-on-daemon");
    const { toastsStore } = await import("./toasts");
    const error = vi.spyOn(toastsStore, "error");
    const { layoutPresetsStore } = await import("./layoutPresets");

    await layoutPresetsStore.load("demo");

    expect(layoutPresetsStore.activeId()).toBe("custom-default");
    expect(error).toHaveBeenCalledOnce();
    expect(layoutPresetsStore.presets().find((preset) => preset.id === "broken")?.layout)
      .toEqual((await import("@/lib/layoutPresets")).builtinPreset("code")!.layout);

    prefsStore.setActivePresetId("still-missing");
    responses([], "also-missing");
    await layoutPresetsStore.load("demo");
    expect(layoutPresetsStore.activeId()).toBe("code");
  });

  it("forks a built-in once and debounces exactly one remote save for 250ms", async () => {
    vi.useFakeTimers();
    responses([]);
    const { layoutPresetsStore } = await import("./layoutPresets");
    const { layoutStore } = await import("./layout");
    await layoutPresetsStore.load();
    send.mockClear();

    layoutStore.resizeRegion("right", 410);
    layoutStore.collapseRegion("left", true);
    layoutStore.hidePanel("files");
    const fork = layoutStore.activePreset().id;
    layoutStore.movePanel("summary", "left", 0);
    expect(fork).toMatch(/^custom-/);
    expect(layoutStore.activePreset().id).toBe(fork);
    await vi.advanceTimersByTimeAsync(249);
    expect(send).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);

    expect(send).toHaveBeenCalledOnce();
    expect(send.mock.calls[0][0]).toMatchObject({
      type: "save_layout_preset",
      preset: { id: fork, builtin: false },
    });
    const request = send.mock.calls[0][0];
    if (request.type !== "save_layout_preset") throw new Error("expected save request");
    const savedLayout = JSON.parse(request.preset.layout_json);
    expect(savedLayout.regions.right.size).toBe(300);
    expect(savedLayout.regions.left.collapsed).toBe(false);
  });

  it("keeps local edits when sync fails and offers one retry toast", async () => {
    vi.useFakeTimers();
    responses([]);
    const { layoutPresetsStore } = await import("./layoutPresets");
    const { layoutStore } = await import("./layout");
    const { toastsStore } = await import("./toasts");
    await layoutPresetsStore.load();
    const push = vi.spyOn(toastsStore, "push");
    send.mockRejectedValueOnce(new Error("offline"));

    layoutStore.hidePanel("files");
    const local = structuredClone(layoutStore.layout());
    await vi.advanceTimersByTimeAsync(250);

    expect(layoutStore.layout()).toEqual(local);
    expect(push).toHaveBeenCalledOnce();
    expect(push.mock.calls[0][1]).toBe("error");
    expect(push.mock.calls[0][3]?.label).toBe("Retry");
  });

  it("selects immediately, protects built-ins, deletes users, and sets a project default", async () => {
    responses([record("custom-one", "Mine", await codeLayout())]);
    const { layoutPresetsStore } = await import("./layoutPresets");
    await layoutPresetsStore.load("demo");
    send.mockClear();

    expect(layoutPresetsStore.select("wide")).toBe(true);
    expect(layoutPresetsStore.activeId()).toBe("wide");
    expect(await layoutPresetsStore.delete("wide")).toBe(false);
    expect(send).not.toHaveBeenCalled();
    expect(await layoutPresetsStore.delete("custom-one")).toBe(true);
    expect(send).toHaveBeenCalledWith({ type: "delete_layout_preset", id: "custom-one" });

    await layoutPresetsStore.setProjectDefault("demo", "wide");
    expect(send).toHaveBeenCalledWith({
      type: "set_project_default_preset",
      repository: "demo",
      preset_id: "wide",
    });
    expect(layoutPresetsStore.projectDefaultId()).toBe("wide");
  });

  it("saves a named working copy and renames user presets", async () => {
    responses([]);
    const { layoutPresetsStore } = await import("./layoutPresets");
    await layoutPresetsStore.load();
    send.mockClear();

    expect(await layoutPresetsStore.saveWorkingCopy("Team layout")).toBe(true);
    const copyId = layoutPresetsStore.activeId();
    expect(copyId).toMatch(/^custom-/);
    expect(layoutPresetsStore.activePreset()?.name).toBe("Team layout");
    expect(await layoutPresetsStore.rename("Team layout 2")).toBe(true);
    expect(layoutPresetsStore.activePreset()).toMatchObject({ id: copyId, name: "Team layout 2" });
    expect(send).toHaveBeenCalledTimes(2);
  });
});
