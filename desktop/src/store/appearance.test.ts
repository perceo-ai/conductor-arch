// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

const send = vi.fn();
vi.mock("@/bridge/client", () => ({ send }));

const COMPLETE_TOML = `
[customization.view]
theme = "system"
accent_color = "#123456"
density = "comfortable"
ui_font = "Inter, sans-serif"
ui_font_size = 14
code_font = "JetBrains Mono, monospace"
code_font_size = 15
terminal_font = "Iosevka, monospace"
terminal_font_size = 16
terminal_scrollback = 9000

[customization.view.colors]
background = "#010101"
surface = "#020202"
surface_raised = "#030303"
surface_muted = "#040404"
hover = "#050505"
hover_soft = "#060606"
border = "#070707"
border_strong = "#080808"
text = "#090909"
text_strong = "#101010"
text_muted = "#111111"
accent = "#121212"
accent_fg = "#131313"
success = "#141414"
warning = "#151515"
danger = "#161616"
`;

describe("appearance projection", () => {
  beforeEach(() => {
    vi.resetModules();
    send.mockReset();
    document.body.className = "";
    document.documentElement.removeAttribute("style");
  });

  it("projects every supported color and font role into stable CSS tokens", async () => {
    const { applyAppearance, parseAppearance } = await import("./appearance");
    const appearance = parseAppearance(COMPLETE_TOML);
    applyAppearance(appearance, document, { matches: true } as MediaQueryList);

    const root = document.documentElement.style;
    expect(root.getPropertyValue("--lc-bg")).toBe("#010101");
    expect(root.getPropertyValue("--lc-surface")).toBe("#020202");
    expect(root.getPropertyValue("--lc-surface-raised")).toBe("#030303");
    expect(root.getPropertyValue("--lc-surface-muted")).toBe("#040404");
    expect(root.getPropertyValue("--lc-hover")).toBe("#050505");
    expect(root.getPropertyValue("--lc-hover-soft")).toBe("#060606");
    expect(root.getPropertyValue("--lc-border")).toBe("#070707");
    expect(root.getPropertyValue("--lc-border-strong")).toBe("#080808");
    expect(root.getPropertyValue("--lc-text")).toBe("#090909");
    expect(root.getPropertyValue("--lc-text-strong")).toBe("#101010");
    expect(root.getPropertyValue("--lc-text-muted")).toBe("#111111");
    expect(root.getPropertyValue("--lc-accent")).toBe("#121212");
    expect(root.getPropertyValue("--lc-accent-fg")).toBe("#131313");
    expect(root.getPropertyValue("--lc-success")).toBe("#141414");
    expect(root.getPropertyValue("--lc-warning")).toBe("#151515");
    expect(root.getPropertyValue("--lc-danger")).toBe("#161616");
    expect(root.getPropertyValue("--ui-panel")).toBe("#020202");
    expect(root.getPropertyValue("--ui-panel-2")).toBe("#040404");
    expect(root.getPropertyValue("--ui-panel-3")).toBe("#030303");
    expect(root.getPropertyValue("--ui-panel-hover")).toBe("#050505");
    expect(root.getPropertyValue("--ui-border")).toBe("#070707");
    expect(root.getPropertyValue("--ui-border-strong")).toBe("#080808");
    expect(root.getPropertyValue("--lc-status-success")).toBe("#141414");
    expect(root.getPropertyValue("--lc-status-warning")).toBe("#151515");
    expect(root.getPropertyValue("--lc-status-danger")).toBe("#161616");
    expect(root.getPropertyValue("--ui-font-sans")).toBe("Inter, sans-serif");
    expect(root.getPropertyValue("--ui-font-mono")).toBe("JetBrains Mono, monospace");
    expect(root.getPropertyValue("--ui-text")).toBe("14px");
    expect(root.getPropertyValue("--code-size")).toBe("15px");
    expect(document.body.classList.contains("lc-custom-colors")).toBe(true);
    expect(document.body.classList.contains("lc-theme-dark")).toBe(true);
    expect(document.body.classList.contains("lc-density-comfortable")).toBe(true);
  });

  it("uses safe defaults when effective TOML omits appearance", async () => {
    const { DEFAULT_APPEARANCE, parseAppearance } = await import("./appearance");
    expect(parseAppearance("[scripts]\nrun = \"pnpm dev\"\n")).toEqual(DEFAULT_APPEARANCE);
  });

  it("resolves explicit and system theme modes without changing the saved mode", async () => {
    const { applyAppearance, parseAppearance } = await import("./appearance");
    const light = parseAppearance('[customization.view]\ntheme = "light"\n');
    applyAppearance(light, document, { matches: true } as MediaQueryList);
    expect(document.body.classList.contains("lc-theme-light")).toBe(true);

    const system = parseAppearance('[customization.view]\ntheme = "system"\n');
    applyAppearance(system, document, { matches: false } as MediaQueryList);
    expect(system.theme).toBe("system");
    expect(document.body.classList.contains("lc-theme-light")).toBe(true);
  });

  it("puts explicit runtime colors on the theme element so light tokens cannot shadow them", async () => {
    const { applyAppearance, parseAppearance } = await import("./appearance");
    const light = parseAppearance(`
[customization.view]
theme = "light"
[customization.view.colors]
background = "#abcdef"
surface = "#fedcba"
`);

    applyAppearance(light, document, { matches: false } as MediaQueryList, ["background", "surface"]);

    expect(document.body.style.getPropertyValue("--lc-bg")).toBe("#abcdef");
    expect(document.body.style.getPropertyValue("--lc-surface")).toBe("#fedcba");
    expect(document.body.style.getPropertyValue("--ui-panel")).toBe("#fedcba");
  });

  it("derives xterm options from the same effective settings", async () => {
    const { terminalOptions, parseAppearance } = await import("./appearance");
    expect(terminalOptions(parseAppearance(COMPLETE_TOML))).toEqual({
      fontFamily: "Iosevka, monospace",
      fontSize: 16,
      scrollback: 9000,
      theme: { background: "#010101", foreground: "#090909" },
    });
  });

  it("refreshes from global effective settings and applies them", async () => {
    send.mockResolvedValue({ type: "settings", scope: "global", toml: COMPLETE_TOML });
    const { appearanceStore } = await import("./appearance");

    await appearanceStore.refresh();

    expect(send).toHaveBeenCalledWith({ type: "get_settings" });
    expect(appearanceStore.state.uiFont).toBe("Inter, sans-serif");
    expect(document.documentElement.style.getPropertyValue("--lc-danger")).toBe("#161616");
  });
});
