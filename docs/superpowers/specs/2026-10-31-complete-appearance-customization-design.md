# Complete Appearance Customization

## Intent

Archductor must expose the appearance settings its core model already promises. A user should be able to customize the desktop without editing CSS, and the CLI must read and write the same durable settings.

## Scope

- Make app-shared `customization.view` the authority for desktop appearance.
- Edit theme, accent, density, all 16 supported semantic colors, UI font, code font, terminal font, their sizes, and terminal scrollback in Electron.
- Apply saved settings at startup and immediately after save.
- Apply terminal font, size, scrollback, background, and foreground to new terminals.
- Preserve repository and local override support in the settings schema and raw settings editor.
- Keep CLI parity through `archductor archcar settings`, `settings-source`, and `save-settings`, using the same documented TOML keys and validation.
- Keep the four accent presets as shortcuts. Selecting one writes the real `accent_color` and `colors.accent` values.
- Support `system`, `dark`, and `light` themes. System follows `prefers-color-scheme`.
- Provide reset controls that remove explicit values and restore inherited/default values.

## Data Model

Existing `customization.view.colors` remains the color map. Supported keys are `background`, `surface`, `surface_raised`, `surface_muted`, `hover`, `hover_soft`, `border`, `border_strong`, `text`, `text_strong`, `text_muted`, `accent`, `accent_fg`, `success`, `warning`, and `danger`.

Add explicit typography fields to `customization.view`: `ui_font`, `ui_font_size`, `code_font`, `code_font_size`, and `terminal_font_size`. Keep the existing `terminal_font` and `terminal_scrollback` fields. Font names are CSS font-family values; sizes are whole CSS pixels.

Defaults remain centralized in core and serialize through effective settings, so Electron and CLI observe the same values. Validation accepts font sizes from 9 through 32 pixels and terminal scrollback from 100 through 100,000 lines. Font strings must be non-empty and contain no NUL bytes.

## Desktop Behavior

Settings gains a dedicated Appearance section. It shows grouped controls for mode, density, colors, typography, and terminal behavior. Color controls pair a native color input with a validated hex text input. Changes stay in the settings draft until Save; the app applies the saved effective settings after the daemon confirms persistence. Reset removes overrides from the source draft.

The renderer loads effective app-shared settings on startup into one appearance store. That store projects settings to CSS classes and variables. Existing localStorage theme, accent, and density values are migration fallback only until the daemon settings load; new appearance changes do not persist to localStorage.

The command palette uses the same durable appearance update path for theme and accent actions.

## CLI Behavior

No parallel appearance format is introduced. `archductor archcar settings` prints effective values. `settings-source` prints the editable layer. `save-settings` validates and persists all appearance keys. The settings guide includes complete CLI examples for reading, changing, and resetting appearance.

## Non-goals

- A visual theme marketplace, named theme files, import/export UI, or automatic palette generation.
- Per-component CSS overrides.
- Retokenizing every historical hard-coded CSS literal in this change. The 16 semantic tokens cover the supported customization contract; remaining literals are follow-up design-system debt.
- Changing appearance automatically when the selected workspace changes. Repository view overrides remain data-model support until product semantics for per-project themes are chosen.

## Acceptance

- A saved appearance survives desktop restart and is visible through the CLI.
- Every supported color key has an Electron control and changes its matching CSS token.
- UI, code, and terminal fonts and sizes affect their intended surfaces.
- Invalid colors, font sizes, font strings, and scrollback values are rejected before persistence.
- Theme, accent, and density no longer have competing durable authorities.
- Focused written tests, CLI smoke, Electron build/typecheck, and a launched Electron smoke all pass.
