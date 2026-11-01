import { createStore } from "solid-js/store";
import { send, sendToDaemon } from "@/bridge/client";
import { readTomlValue, writeTomlValue, type TomlValueKind } from "@/pages/settings/toml";
import { clientsStore } from "./clients";

export const COLOR_KEYS = [
  "background",
  "surface",
  "surface_raised",
  "surface_muted",
  "hover",
  "hover_soft",
  "border",
  "border_strong",
  "text",
  "text_strong",
  "text_muted",
  "accent",
  "accent_fg",
  "success",
  "warning",
  "danger",
] as const;

export const ACCENT_PRESETS = [
  ["Amber", "#c39b50"], ["Blue", "#5b8def"], ["Green", "#3fb27f"], ["Rose", "#e0567b"],
] as const;

export const HEX_COLOR = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

/** `accent_color` holds either a hex color or a preset name such as "blue". */
function resolveAccentColor(value: string): string | undefined {
  if (HEX_COLOR.test(value)) return value.toLowerCase();
  return ACCENT_PRESETS.find(([label]) => label.toLowerCase() === value.trim().toLowerCase())?.[1];
}

export type AppearanceColorKey = (typeof COLOR_KEYS)[number];
export type AppearanceTheme = "system" | "dark" | "light";
export type AppearanceDensity = "compact" | "cozy" | "comfortable";

export interface Appearance {
  theme: AppearanceTheme;
  accentColor: string;
  density: AppearanceDensity;
  colors: Record<AppearanceColorKey, string>;
  uiFont: string;
  uiFontSize: number;
  codeFont: string;
  codeFontSize: number;
  terminalFont: string;
  terminalFontSize: number;
  terminalScrollback: number;
}

const DEFAULT_MONO = "Commit Mono, JetBrains Mono, SF Mono, Cascadia Mono, Menlo, monospace";

export const DEFAULT_APPEARANCE: Appearance = {
  theme: "system",
  accentColor: "#5b9dff",
  density: "compact",
  colors: {
    background: "#191919",
    surface: "#1e1e1e",
    surface_raised: "#202020",
    surface_muted: "#181818",
    hover: "#2a2a2a",
    hover_soft: "#242424",
    border: "#2a2a2a",
    border_strong: "#3a3a3a",
    text: "#e4e4e4",
    text_strong: "#f8fafc",
    text_muted: "#8a8a8a",
    accent: "#5b9dff",
    accent_fg: "#071a33",
    success: "#d0d0d0",
    warning: "#f59e0b",
    danger: "#ff8a8a",
  },
  uiFont: "Mona Sans, Inter, SF Pro Text, Segoe UI, sans-serif",
  uiFontSize: 13,
  codeFont: DEFAULT_MONO,
  codeFontSize: 13,
  terminalFont: DEFAULT_MONO,
  terminalFontSize: 13,
  terminalScrollback: 5000,
};

const CSS_COLOR_TOKENS: Record<AppearanceColorKey, string> = {
  background: "--lc-bg",
  surface: "--lc-surface",
  surface_raised: "--lc-surface-raised",
  surface_muted: "--lc-surface-muted",
  hover: "--lc-hover",
  hover_soft: "--lc-hover-soft",
  border: "--lc-border",
  border_strong: "--lc-border-strong",
  text: "--lc-text",
  text_strong: "--lc-text-strong",
  text_muted: "--lc-text-muted",
  accent: "--lc-accent",
  accent_fg: "--lc-accent-fg",
  success: "--lc-success",
  warning: "--lc-warning",
  danger: "--lc-danger",
};

const CSS_COLOR_ALIASES: Partial<Record<AppearanceColorKey, readonly string[]>> = {
  surface: ["--ui-panel"],
  surface_raised: ["--ui-panel-3"],
  surface_muted: ["--ui-panel-2"],
  hover: ["--ui-panel-hover"],
  border: ["--ui-border"],
  border_strong: ["--ui-border-strong"],
  success: ["--lc-status-success"],
  warning: ["--lc-status-warning"],
  danger: ["--lc-status-danger"],
};

function stringValue(toml: string, section: string, key: string, fallback: string): string {
  return readTomlValue(toml, section, key) || fallback;
}

function numberValue(toml: string, key: string, fallback: number): number {
  const value = Number.parseInt(readTomlValue(toml, "customization.view", key), 10);
  return Number.isFinite(value) ? value : fallback;
}

export function parseAppearance(toml: string): Appearance {
  const rawTheme = readTomlValue(toml, "customization.view", "theme");
  const theme: AppearanceTheme = ["system", "dark", "light"].includes(rawTheme)
    ? (rawTheme as AppearanceTheme)
    : DEFAULT_APPEARANCE.theme;
  const rawDensity = readTomlValue(toml, "customization.view", "density");
  const density: AppearanceDensity = ["compact", "cozy", "comfortable"].includes(rawDensity)
    ? (rawDensity as AppearanceDensity)
    : DEFAULT_APPEARANCE.density;
  const colors = { ...DEFAULT_APPEARANCE.colors };
  for (const key of COLOR_KEYS) {
    colors[key] = stringValue(toml, "customization.view.colors", key, colors[key]);
  }
  // An explicit colors.accent wins; otherwise a saved accent_color drives the token.
  if (readTomlValue(toml, "customization.view.colors", "accent") === "") {
    const accent = resolveAccentColor(readTomlValue(toml, "customization.view", "accent_color"));
    if (accent) colors.accent = accent;
  }
  return {
    theme,
    accentColor: stringValue(
      toml,
      "customization.view",
      "accent_color",
      colors.accent,
    ),
    density,
    colors,
    uiFont: stringValue(toml, "customization.view", "ui_font", DEFAULT_APPEARANCE.uiFont),
    uiFontSize: numberValue(toml, "ui_font_size", DEFAULT_APPEARANCE.uiFontSize),
    codeFont: stringValue(toml, "customization.view", "code_font", DEFAULT_APPEARANCE.codeFont),
    codeFontSize: numberValue(toml, "code_font_size", DEFAULT_APPEARANCE.codeFontSize),
    terminalFont: stringValue(
      toml,
      "customization.view",
      "terminal_font",
      DEFAULT_APPEARANCE.terminalFont,
    ),
    terminalFontSize: numberValue(toml, "terminal_font_size", DEFAULT_APPEARANCE.terminalFontSize),
    terminalScrollback: numberValue(
      toml,
      "terminal_scrollback",
      DEFAULT_APPEARANCE.terminalScrollback,
    ),
  };
}

export function applyAppearance(
  appearance: Appearance,
  target: Document = document,
  colorScheme?: Pick<MediaQueryList, "matches">,
  explicitColors: readonly AppearanceColorKey[] = COLOR_KEYS,
): void {
  colorScheme ??= typeof window.matchMedia === "function"
    ? window.matchMedia("(prefers-color-scheme: dark)")
    : { matches: true };
  const dark = appearance.theme === "dark" || (appearance.theme === "system" && colorScheme.matches);
  target.body.classList.toggle("lc-theme-dark", dark);
  target.body.classList.toggle("lc-theme-light", !dark);
  target.body.classList.toggle("lc-custom-colors", true);
  for (const density of ["compact", "cozy", "comfortable"]) {
    target.body.classList.toggle(`lc-density-${density}`, appearance.density === density);
  }
  const style = target.documentElement.style;
  const themeStyle = target.body.style;
  const explicit = new Set(explicitColors);
  for (const key of COLOR_KEYS) {
    style.setProperty(CSS_COLOR_TOKENS[key], appearance.colors[key]);
    themeStyle.removeProperty(CSS_COLOR_TOKENS[key]);
    for (const alias of CSS_COLOR_ALIASES[key] ?? []) {
      style.setProperty(alias, appearance.colors[key]);
      themeStyle.removeProperty(alias);
    }
    if (explicit.has(key)) {
      themeStyle.setProperty(CSS_COLOR_TOKENS[key], appearance.colors[key]);
      for (const alias of CSS_COLOR_ALIASES[key] ?? []) {
        themeStyle.setProperty(alias, appearance.colors[key]);
      }
    }
  }
  style.setProperty("--ui-font-sans", appearance.uiFont);
  style.setProperty("--ui-font-mono", appearance.codeFont);
  style.setProperty("--ui-text", `${appearance.uiFontSize}px`);
  style.setProperty("--code-size", `${appearance.codeFontSize}px`);
  style.setProperty("--terminal-font", appearance.terminalFont);
  style.setProperty("--terminal-font-size", `${appearance.terminalFontSize}px`);
}

export function terminalOptions(appearance: Appearance) {
  return {
    fontFamily: appearance.terminalFont,
    fontSize: appearance.terminalFontSize,
    scrollback: appearance.terminalScrollback,
    theme: {
      background: appearance.colors.background,
      foreground: appearance.colors.text,
    },
  };
}

const [state, setState] = createStore<Appearance & { loaded: boolean }>({
  ...DEFAULT_APPEARANCE,
  colors: { ...DEFAULT_APPEARANCE.colors },
  loaded: false,
});

let systemThemeQuery: MediaQueryList | undefined;
let systemThemeListener: (() => void) | undefined;
let explicitColorKeys: AppearanceColorKey[] = [];

function isDarkAppearance(
  appearance: Pick<Appearance, "theme">,
  colorScheme: Pick<MediaQueryList, "matches">,
): boolean {
  return appearance.theme === "dark" || (appearance.theme === "system" && colorScheme.matches);
}

function applyCurrent(): void {
  if (typeof document === "undefined" || typeof window === "undefined") return;
  systemThemeQuery ??= typeof window.matchMedia === "function"
    ? window.matchMedia("(prefers-color-scheme: dark)")
    : ({ matches: true, addEventListener: () => {} } as unknown as MediaQueryList);
  applyAppearance(state, document, systemThemeQuery, explicitColorKeys);
  if (!systemThemeListener) {
    systemThemeListener = () => {
      if (state.theme === "system") {
        applyAppearance(state, document, systemThemeQuery!, explicitColorKeys);
      }
    };
    systemThemeQuery.addEventListener?.("change", systemThemeListener);
  }
}

export const appearanceStore = {
  state,
  async refresh(): Promise<void> {
    const [response, source] = await Promise.all([
      send({ type: "get_settings" }),
      send({ type: "get_settings_source" }),
    ]);
    if (response.type !== "settings") return;
    explicitColorKeys = source.type === "settings_source"
      ? COLOR_KEYS.filter((key) => readTomlValue(
        source.toml,
        "customization.view.colors",
        key,
      ) !== "")
      : [];
    setState({ ...parseAppearance(response.toml), loaded: true });
    applyCurrent();
  },
  apply: applyCurrent,
  resolvedTheme: (): "dark" | "light" => {
    const query = typeof window !== "undefined" && typeof window.matchMedia === "function"
      ? window.matchMedia("(prefers-color-scheme: dark)")
      : { matches: true };
    return isDarkAppearance(state, query) ? "dark" : "light";
  },
  terminalOptions: () => terminalOptions(state),
};

export interface AppearanceUpdate {
  section: "customization.view" | "customization.view.colors";
  key: string;
  value: string;
  kind?: TomlValueKind;
}

export async function updateGlobalAppearance(updates: AppearanceUpdate[]): Promise<void> {
  // Read and save on the same daemon even if the selection switches in between.
  const daemon = clientsStore.selectedDaemon();
  const source = await sendToDaemon(daemon, { type: "get_settings_source" });
  if (source.type !== "settings_source") {
    throw new Error(source.type === "error" ? source.message : "Could not load app-shared settings");
  }
  const toml = updates.reduce(
    (current, update) =>
      writeTomlValue(current, update.section, update.key, update.value, update.kind ?? "string"),
    source.toml,
  );
  const saved = await sendToDaemon(daemon, { type: "save_settings", toml });
  if (saved.type !== "settings_saved") {
    throw new Error(saved.type === "error" ? saved.message : "Could not save app-shared settings");
  }
  await appearanceStore.refresh();
}
