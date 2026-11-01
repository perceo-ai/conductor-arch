// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "solid-js/web";
import type { ArchcarRequest, ArchcarResponse } from "@/bridge/protocol";

const send = vi.fn<(request: ArchcarRequest) => Promise<ArchcarResponse>>();
vi.mock("@/bridge/client", () => ({ send }));

const EFFECTIVE = `
[customization.view]
theme = "dark"
density = "compact"
ui_font = "Inter, sans-serif"
ui_font_size = 13
code_font = "JetBrains Mono, monospace"
code_font_size = 13
terminal_font = "Iosevka, monospace"
terminal_font_size = 14
terminal_scrollback = 5000

[customization.view.colors]
background = "#191919"
surface = "#1e1e1e"
surface_raised = "#202020"
surface_muted = "#181818"
hover = "#2a2a2a"
hover_soft = "#242424"
border = "#2a2a2a"
border_strong = "#3a3a3a"
text = "#e4e4e4"
text_strong = "#f8fafc"
text_muted = "#8a8a8a"
accent = "#5b9dff"
accent_fg = "#071a33"
success = "#d0d0d0"
warning = "#f59e0b"
danger = "#ff8a8a"
`;

let dispose: (() => void) | undefined;

function responses(source = "", sourceError = false) {
  send.mockImplementation(async (request) => {
    if (request.type === "get_settings") return { type: "settings", scope: "global", toml: EFFECTIVE };
    if (request.type === "get_settings_source") {
      if (sourceError) return { type: "error", message: "source unavailable" };
      return { type: "settings_source", scope: "global", layer: "global", toml: source };
    }
    if (request.type === "save_settings") return { type: "settings_saved", scope: "global", layer: "global" };
    return { type: "ack" };
  });
}

async function mount(source = "", sourceError = false) {
  responses(source, sourceError);
  const { default: AppearanceSettings } = await import("./AppearanceSettings");
  const host = document.createElement("div");
  document.body.append(host);
  dispose = render(() => <AppearanceSettings />, host);
  await vi.waitFor(() => expect(host.querySelectorAll("[data-color-key]")).toHaveLength(16));
  await vi.waitFor(() =>
    expect(host.querySelector<HTMLInputElement>('[name="ui_font"]')?.value).toBe(
      source.includes("Comic Sans MS") ? "Comic Sans MS" : "Inter, sans-serif",
    ),
  );
  return host;
}

afterEach(() => {
  dispose?.();
  dispose = undefined;
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

beforeEach(() => {
  send.mockReset();
});

describe("AppearanceSettings", () => {
  it("previews alpha hex values without replacing their RGB channels", async () => {
    const { sixDigitColor } = await import("./AppearanceSettings");
    expect(sixDigitColor("#1234")).toBe("#112233");
    expect(sixDigitColor("#11223344")).toBe("#112233");
  });

  it("renders every supported semantic color and all typography roles", async () => {
    const host = await mount();
    const keys = [...host.querySelectorAll<HTMLElement>("[data-color-key]")].map(
      (node) => node.dataset.colorKey,
    );

    expect(keys).toEqual([
      "background", "surface", "surface_raised", "surface_muted", "hover", "hover_soft",
      "border", "border_strong", "text", "text_strong", "text_muted", "accent", "accent_fg",
      "success", "warning", "danger",
    ]);
    expect(host.querySelector<HTMLInputElement>('[name="ui_font"]')?.value).toBe("Inter, sans-serif");
    expect(host.querySelector<HTMLInputElement>('[name="code_font"]')?.value).toBe("JetBrains Mono, monospace");
    expect(host.querySelector<HTMLInputElement>('[name="terminal_font"]')?.value).toBe("Iosevka, monospace");
    expect(host.querySelector<HTMLInputElement>('[name="terminal_scrollback"]')?.value).toBe("5000");
  });

  it("does not put invalid hex into the source that gets saved", async () => {
    const host = await mount();
    const hex = host.querySelector<HTMLInputElement>('[data-color-key="accent"] input[type="text"]')!;

    hex.value = "red";
    hex.dispatchEvent(new Event("change", { bubbles: true }));
    expect(host.textContent).toContain("Use a hex color");
    expect(host.querySelector<HTMLButtonElement>('[data-action="save-appearance"]')?.disabled).toBe(true);

    hex.value = "#abcdef";
    hex.dispatchEvent(new Event("change", { bubbles: true }));
    const save = host.querySelector<HTMLButtonElement>('[data-action="save-appearance"]')!;
    expect(save.disabled).toBe(false);
    save.click();
    await vi.waitFor(() =>
      expect(send.mock.calls.some(([request]) => request.type === "save_settings")).toBe(true),
    );
    const request = send.mock.calls.map(([value]) => value).find((value) => value.type === "save_settings");
    expect(request).toMatchObject({ toml: expect.stringContaining('accent = "#abcdef"') });
    expect((request as { toml: string }).toml).not.toContain('accent = "red"');
  });

  it("saves font and terminal controls into the app-shared source", async () => {
    const host = await mount();
    const uiFont = host.querySelector<HTMLInputElement>('[name="ui_font"]')!;
    const terminalSize = host.querySelector<HTMLInputElement>('[name="terminal_font_size"]')!;

    uiFont.value = "Georgia, serif";
    uiFont.dispatchEvent(new Event("change", { bubbles: true }));
    terminalSize.value = "17";
    terminalSize.dispatchEvent(new Event("change", { bubbles: true }));
    host.querySelector<HTMLButtonElement>('[data-action="save-appearance"]')!.click();

    await vi.waitFor(() =>
      expect(send.mock.calls.some(([request]) => request.type === "save_settings")).toBe(true),
    );
    const request = send.mock.calls.map(([value]) => value).find((value) => value.type === "save_settings");
    expect(request).toMatchObject({
      toml: expect.stringContaining('ui_font = "Georgia, serif"'),
    });
    expect((request as { toml: string }).toml).toContain("terminal_font_size = 17");
  });

  it("fails closed when the editable source cannot be loaded", async () => {
    const host = await mount("", true);

    await vi.waitFor(() => expect(host.textContent).toContain("source unavailable"));
    expect(host.querySelector<HTMLFieldSetElement>("fieldset")?.disabled).toBe(true);
    expect(host.querySelector<HTMLButtonElement>('[data-action="save-appearance"]')?.disabled).toBe(true);
    expect(send.mock.calls.some(([request]) => request.type === "save_settings")).toBe(false);
  });

  it("resets mode, density, and both persisted accent fields together", async () => {
    const host = await mount(`[customization.view]
theme = "light"
density = "comfortable"
accent_color = "#abcdef"

[customization.view.colors]
accent = "#abcdef"
`);

    host.querySelector<HTMLButtonElement>('[title="Reset Theme"]')!.click();
    host.querySelector<HTMLButtonElement>('[title="Reset Density"]')!.click();
    host.querySelector<HTMLButtonElement>('[title="Reset Accent color"]')!.click();
    host.querySelector<HTMLButtonElement>('[data-action="save-appearance"]')!.click();

    await vi.waitFor(() =>
      expect(send.mock.calls.some(([request]) => request.type === "save_settings")).toBe(true),
    );
    const request = send.mock.calls.map(([value]) => value).find((value) => value.type === "save_settings");
    const toml = (request as { toml: string }).toml;
    expect(toml).not.toContain("theme =");
    expect(toml).not.toContain("density =");
    expect(toml).not.toContain("accent_color =");
    expect(toml).not.toContain("accent =");
  });

  it("removes a field override on reset and refreshes effective appearance after save", async () => {
    const host = await mount('[customization.view]\nui_font = "Comic Sans MS"\n');
    const reset = host.querySelector<HTMLButtonElement>('[title="Reset UI font"]')!;
    reset.click();
    host.querySelector<HTMLButtonElement>('[data-action="save-appearance"]')!.click();

    await vi.waitFor(() =>
      expect(send.mock.calls.filter(([request]) => request.type === "get_settings").length).toBeGreaterThan(1),
    );
    const request = send.mock.calls.map(([value]) => value).find((value) => value.type === "save_settings");
    expect((request as { toml: string }).toml).not.toContain("ui_font");
    expect(host.textContent).toContain("Saved");
  });

  it("replays only this screen's edits onto fresh source so an out-of-band save survives", async () => {
    let backendSource = '[customization.view]\ntheme = "dark"\n';
    const host = await mount(backendSource);
    send.mockImplementation(async (request) => {
      if (request.type === "get_settings") return { type: "settings", scope: "global", toml: EFFECTIVE };
      if (request.type === "get_settings_source") {
        return { type: "settings_source", scope: "global", layer: "global", toml: backendSource };
      }
      if (request.type === "save_settings") {
        backendSource = request.toml;
        return { type: "settings_saved", scope: "global", layer: "global" };
      }
      return { type: "ack" };
    });
    const uiFont = host.querySelector<HTMLInputElement>('[name="ui_font"]')!;
    uiFont.value = "Georgia, serif";
    uiFont.dispatchEvent(new Event("change", { bubbles: true }));

    backendSource = '[customization.view]\ntheme = "light"\n';
    host.querySelector<HTMLButtonElement>('[data-action="save-appearance"]')!.click();

    await vi.waitFor(() =>
      expect(send.mock.calls.some(([request]) => request.type === "save_settings")).toBe(true),
    );
    const request = send.mock.calls.map(([value]) => value).find((value) => value.type === "save_settings");
    const toml = (request as { toml: string }).toml;
    expect(toml).toContain('ui_font = "Georgia, serif"');
    expect(toml).toContain('theme = "light"');
    expect(toml).not.toContain('theme = "dark"');
  });

  it("locks color controls when the source defines colors as an inline table", async () => {
    const host = await mount('[customization.view]\ntheme = "dark"\ncolors = { accent = "#abcdef" }\n');

    await vi.waitFor(() =>
      expect(host.querySelector<HTMLInputElement>('[data-color-key="accent"] input[type="text"]')?.disabled).toBe(true),
    );
    expect(host.querySelector<HTMLInputElement>('[data-color-key="accent"] input[type="color"]')?.disabled).toBe(true);
    expect(host.querySelector<HTMLButtonElement>('[aria-label="Blue accent"]')?.disabled).toBe(true);
    expect(host.textContent).toContain("inline table");
  });

  it("keeps color controls editable for a normal colors section", async () => {
    const host = await mount('[customization.view]\ntheme = "dark"\n\n[customization.view.colors]\naccent = "#abcdef"\n');

    expect(host.querySelector<HTMLInputElement>('[data-color-key="accent"] input[type="text"]')?.disabled).toBe(false);
    expect(host.textContent).not.toContain("inline table");
  });
});
