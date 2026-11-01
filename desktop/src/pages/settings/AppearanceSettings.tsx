import { For, Show, createEffect, createResource, createSignal } from "solid-js";
import { send } from "@/bridge/client";
import {
  ACCENT_PRESETS,
  appearanceStore,
  COLOR_KEYS,
  DEFAULT_APPEARANCE,
  HEX_COLOR,
  type AppearanceColorKey,
} from "@/store/appearance";
import Icon from "@/components/Icon";
import { readTomlValue, tomlSectionBounds, writeTomlValue, type TomlValueKind } from "./toml";
import { SettingsRow, SettingsSectionBlock } from "./SettingsControls";

const COLOR_LABELS: Record<AppearanceColorKey, string> = {
  background: "Background", surface: "Surface", surface_raised: "Raised surface",
  surface_muted: "Muted surface", hover: "Hover", hover_soft: "Soft hover",
  border: "Border", border_strong: "Strong border", text: "Text",
  text_strong: "Strong text", text_muted: "Muted text", accent: "Accent",
  accent_fg: "Accent text", success: "Success", warning: "Warning", danger: "Danger",
};

interface AppearanceEdit {
  section: string;
  key: string;
  value: string;
  kind: TomlValueKind;
}

/**
 * `colors = { ... }` inside `[customization.view]` is valid TOML the daemon
 * keeps, but the line-based writer cannot edit it: it would add a second
 * `[customization.view.colors]` table, which the daemon then rejects.
 */
export function hasInlineColorsTable(source: string): boolean {
  const lines = source.split("\n");
  const bounds = tomlSectionBounds(lines, "customization.view");
  if (!bounds) return false;
  return lines.slice(bounds[0] + 1, bounds[1]).some((line) => /^\s*colors\s*=\s*\{/.test(line));
}

export function sixDigitColor(value: string): string {
  if (/^#[0-9a-f]{6}$/i.test(value)) return value;
  if (/^#[0-9a-f]{8}$/i.test(value)) return value.slice(0, 7);
  if (/^#[0-9a-f]{3,4}$/i.test(value)) {
    return `#${value.slice(1, 4).split("").map((part) => `${part}${part}`).join("")}`;
  }
  return "#000000";
}

export default function AppearanceSettings() {
  const [settings, { refetch }] = createResource(async () => {
    const [effective, source] = await Promise.all([
      send({ type: "get_settings" }),
      send({ type: "get_settings_source" }),
    ]);
    if (effective.type !== "settings") {
      return {
        effective: "",
        source: "",
        error: effective.type === "error" ? effective.message : "Could not load effective settings",
      };
    }
    if (source.type !== "settings_source") {
      return {
        effective: effective.toml,
        source: "",
        error: source.type === "error" ? source.message : "Could not load app-shared settings",
      };
    }
    return { effective: effective.toml, source: source.toml, error: "" };
  });
  const [draft, setDraft] = createSignal("");
  // The keys this screen changed, replayed onto fresh source at save time so a
  // change saved elsewhere while this screen was open is not overwritten.
  const [edits, setEdits] = createSignal<AppearanceEdit[]>([]);
  const [baseline, setBaseline] = createSignal("");
  const [status, setStatus] = createSignal("");
  const [saving, setSaving] = createSignal(false);

  createEffect(() => {
    const loaded = settings();
    if (!loaded) return;
    setDraft(loaded.source);
    setBaseline(loaded.source);
    setEdits([]);
    setStatus("");
  });

  const dirty = () => draft() !== baseline();
  const editable = () => Boolean(settings()) && !settings()?.error;
  const colorsLocked = () => hasInlineColorsTable(settings()?.source ?? "");
  const value = (section: string, key: string, fallback: string) =>
    readTomlValue(draft(), section, key) || readTomlValue(settings()?.effective ?? "", section, key) || fallback;
  const write = (section: string, key: string, next: string, kind: TomlValueKind = "string") => {
    setDraft((current) => writeTomlValue(current, section, key, next, kind));
    setEdits((current) => [
      ...current.filter((edit) => edit.section !== section || edit.key !== key),
      { section, key, value: next, kind },
    ]);
    setStatus("");
  };
  const reset = (section: string, key: string) => write(section, key, "");
  const resetAccent = () => {
    write("customization.view.colors", "accent", "");
    write("customization.view", "accent_color", "");
  };
  const colorValue = (key: AppearanceColorKey) =>
    value("customization.view.colors", key, DEFAULT_APPEARANCE.colors[key]);
  const setColor = (key: AppearanceColorKey, next: string) => {
    if (!HEX_COLOR.test(next)) {
      setStatus("Use a hex color such as #5b9dff.");
      return;
    }
    write("customization.view.colors", key, next.toLowerCase());
    if (key === "accent") write("customization.view", "accent_color", next.toLowerCase());
  };

  async function save() {
    if (!dirty() || saving()) return;
    setSaving(true);
    setStatus("Saving...");
    try {
      const fresh = await send({ type: "get_settings_source" });
      if (fresh.type !== "settings_source") {
        setStatus(fresh.type === "error" ? `Save failed: ${fresh.message}` : "Save failed");
        return;
      }
      const toml = edits().reduce(
        (current, edit) => writeTomlValue(current, edit.section, edit.key, edit.value, edit.kind),
        fresh.toml,
      );
      const response = await send({ type: "save_settings", toml });
      if (response.type !== "settings_saved") {
        setStatus(response.type === "error" ? `Save failed: ${response.message}` : "Save failed");
        return;
      }
      await appearanceStore.refresh();
      await refetch();
      setStatus("Saved");
    } catch (error) {
      setStatus(`Save failed: ${(error as Error).message}`);
    } finally {
      setSaving(false);
    }
  }

  const resetButton = (label: string, section: string, key: string) => (
    <button class="settings-icon-button" title={`Reset ${label}`} aria-label={`Reset ${label}`} onClick={() => reset(section, key)}>
      <Icon name="refresh" />
    </button>
  );

  return (
    <div class="settings-content-narrow appearance-settings">
      <h1>Appearance</h1>
      <Show when={settings()?.error}>
        <div class="settings-loading" role="alert">{settings()?.error}</div>
      </Show>
      <fieldset class="settings-fieldset" disabled={!editable()}>
      <SettingsSectionBlock title="Mode">
        <SettingsRow title="Theme" description="Follow the operating system or choose a fixed mode." control={
          <div class="settings-inline-control"><div class="settings-segmented">
            <For each={["system", "dark", "light"] as const}>{(theme) => (
              <button classList={{ active: value("customization.view", "theme", DEFAULT_APPEARANCE.theme) === theme }} onClick={() => write("customization.view", "theme", theme)}>
                {theme[0].toUpperCase() + theme.slice(1)}
              </button>
            )}</For>
          </div>{resetButton("Theme", "customization.view", "theme")}</div>
        } />
        <SettingsRow title="Density" description="Adjust spacing across lists and controls." control={
          <div class="settings-inline-control"><div class="settings-segmented">
            <For each={["compact", "cozy", "comfortable"] as const}>{(density) => (
              <button classList={{ active: value("customization.view", "density", DEFAULT_APPEARANCE.density) === density }} onClick={() => write("customization.view", "density", density)}>
                {density[0].toUpperCase() + density.slice(1)}
              </button>
            )}</For>
          </div>{resetButton("Density", "customization.view", "density")}</div>
        } />
      </SettingsSectionBlock>

      <SettingsSectionBlock title="Colors">
        <Show when={colorsLocked()}>
          <div class="settings-loading" role="note">
            These colors are defined as an inline table in the settings file and can't be edited here — edit the file directly.
          </div>
        </Show>
        <SettingsRow title="Accent presets" description="Shortcuts for the accent token; every color remains independently editable below." control={
          <div class="settings-swatch-row">
            <For each={ACCENT_PRESETS}>{([label, color]) => (
              <button class="settings-swatch" classList={{ active: colorValue("accent").toLowerCase() === color }} style={{ "--swatch": color }} title={label} aria-label={`${label} accent`} disabled={colorsLocked()} onClick={() => setColor("accent", color)} />
            )}</For>
          </div>
        } />
        <For each={COLOR_KEYS}>{(key) => (
          <SettingsRow title={COLOR_LABELS[key]} control={
            <div class="settings-color-control" data-color-key={key}>
              <input type="color" aria-label={`${COLOR_LABELS[key]} color`} disabled={colorsLocked()} value={sixDigitColor(colorValue(key))} onInput={(event) => setColor(key, event.currentTarget.value)} />
              <input type="text" aria-label={`${COLOR_LABELS[key]} hex`} disabled={colorsLocked()} value={colorValue(key)} spellcheck={false} onChange={(event) => setColor(key, event.currentTarget.value)} />
              {key === "accent"
                ? <button class="settings-icon-button" title="Reset Accent color" aria-label="Reset Accent color" onClick={resetAccent}><Icon name="refresh" /></button>
                : resetButton(`${COLOR_LABELS[key]} color`, "customization.view.colors", key)}
            </div>
          } />
        )}</For>
      </SettingsSectionBlock>

      <SettingsSectionBlock title="Typography">
        <For each={[
          ["UI font", "ui_font", DEFAULT_APPEARANCE.uiFont],
          ["Code font", "code_font", DEFAULT_APPEARANCE.codeFont],
          ["Terminal font", "terminal_font", DEFAULT_APPEARANCE.terminalFont],
        ] as const}>{([label, key, fallback]) => (
          <SettingsRow title={label} control={
            <div class="settings-inline-control">
              <input class="settings-control" name={key} value={value("customization.view", key, fallback)} onChange={(event) => write("customization.view", key, event.currentTarget.value)} />
              {resetButton(label, "customization.view", key)}
            </div>
          } />
        )}</For>
        <For each={[
          ["UI font size", "ui_font_size", DEFAULT_APPEARANCE.uiFontSize],
          ["Code font size", "code_font_size", DEFAULT_APPEARANCE.codeFontSize],
          ["Terminal font size", "terminal_font_size", DEFAULT_APPEARANCE.terminalFontSize],
        ] as const}>{([label, key, fallback]) => (
          <SettingsRow title={label} description="9–32 pixels" control={
            <div class="settings-inline-control">
              <input class="settings-control settings-number-control" type="number" name={key} min="9" max="32" value={value("customization.view", key, String(fallback))} onChange={(event) => write("customization.view", key, event.currentTarget.value, "number")} />
              {resetButton(label, "customization.view", key)}
            </div>
          } />
        )}</For>
      </SettingsSectionBlock>

      <SettingsSectionBlock title="Terminal">
        <SettingsRow title="Scrollback" description="100–100,000 lines kept in each new terminal." control={
          <div class="settings-inline-control">
            <input class="settings-control settings-number-control" type="number" name="terminal_scrollback" min="100" max="100000" value={value("customization.view", "terminal_scrollback", String(DEFAULT_APPEARANCE.terminalScrollback))} onChange={(event) => write("customization.view", "terminal_scrollback", event.currentTarget.value, "number")} />
            {resetButton("Terminal scrollback", "customization.view", "terminal_scrollback")}
          </div>
        } />
      </SettingsSectionBlock>

      <SettingsSectionBlock title="Changes">
        <SettingsRow title="App-shared appearance" description="Saved through the daemon and available to the CLI." meta={status() || (dirty() ? "Unsaved changes" : "Saved")} accent={dirty()} control={
          <button class="suggested-action" data-action="save-appearance" disabled={!editable() || !dirty() || saving()} onClick={() => void save()}>
            {saving() ? "Saving..." : "Save"}
          </button>
        } />
      </SettingsSectionBlock>
      </fieldset>
      <Show when={settings.loading}><div class="settings-loading">Loading appearance...</div></Show>
    </div>
  );
}
