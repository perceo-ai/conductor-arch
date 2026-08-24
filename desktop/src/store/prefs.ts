import { createStore } from "solid-js/store";
import { CHAT_PROVIDERS, MODELS, firstModel, providerForModel } from "@/lib/models";
import { REGION_DEFAULT_SIZES, clampRegionSize } from "@/lib/panelWidths";
import type { Region } from "@/lib/layout";

// Renderer-local user preferences, persisted to localStorage. Kept out of the
// archcar TOML settings on purpose: these are per-machine UI defaults (which
// model a brand-new chat starts on), not project config, so they don't need to
// round-trip through the daemon.

const KEY = "archductor.prefs.v1";

export type ThemeMode = "dark" | "light";
export type Accent = "amber" | "blue" | "green" | "rose";
export type Density = "cozy" | "compact" | "comfortable";

// Real hex for each accent so we can drive the global --lc-accent token, not
// just the scoped .lc-accent-* class rules already in theme.css.
export const ACCENT_HEX: Record<Accent, string> = {
  amber: "#c39b50",
  blue: "#5b8def",
  green: "#3fb27f",
  rose: "#e0567b",
};

export interface Prefs {
  // Provider + model a newly created chat is seeded with.
  defaultProvider: string;
  defaultModel: string;
  // Appearance (restored from the GTK theme/accent/density controls).
  theme: ThemeMode;
  accent: Accent;
  density: Density;
  // Persisted layout state so the app restores where you left off.
  sidebarCollapsed: boolean;
  activePresetId: string;
  regionSizes: Record<Region, number>;
  collapsedRegions: Region[];
  // Machine-local keyboard overrides, e.g. "palette=ctrl+p; focus=ctrl+j".
  keybindings: string;
  /**
   * Workspaces pinned to the top of the sidebar. A view preference, not
   * workspace state, so it lives here rather than in the daemon's database —
   * two people pointed at the same daemon should be able to pin differently.
   */
  pinnedWorkspaces: string[];
}

const DEFAULTS: Prefs = {
  defaultProvider: "codex",
  defaultModel: firstModel("codex"),
  theme: "dark",
  accent: "amber",
  density: "cozy",
  sidebarCollapsed: false,
  activePresetId: "code",
  regionSizes: { ...REGION_DEFAULT_SIZES },
  collapsedRegions: [],
  keybindings: "",
  pinnedWorkspaces: [],
};

function persistedPrefs(prefs: Prefs) {
  return {
    defaultProvider: prefs.defaultProvider,
    defaultModel: prefs.defaultModel,
    theme: prefs.theme,
    accent: prefs.accent,
    density: prefs.density,
    sidebarCollapsed: prefs.sidebarCollapsed,
    activePresetId: prefs.activePresetId,
    regionSizes: prefs.regionSizes,
    collapsedRegions: prefs.collapsedRegions,
    keybindings: prefs.keybindings,
    pinnedWorkspaces: prefs.pinnedWorkspaces,
  };
}

function legacySize(key: string): number | undefined {
  const raw = localStorage.getItem(key);
  if (raw === null) return undefined;
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
}

function load(): Prefs {
  try {
    const raw = typeof localStorage !== "undefined" ? localStorage.getItem(KEY) : null;
    const parsed = raw ? (JSON.parse(raw) as Partial<Prefs>) : {};
    const merged: Prefs = {
      ...DEFAULTS,
      ...parsed,
      regionSizes: { ...DEFAULTS.regionSizes, ...parsed.regionSizes },
      collapsedRegions: parsed.collapsedRegions ?? DEFAULTS.collapsedRegions,
    };
    // Drop only the stale model/provider if the model list changed between
    // versions; keep appearance prefs intact.
    if (!MODELS[merged.defaultProvider]?.includes(merged.defaultModel)) {
      merged.defaultProvider = DEFAULTS.defaultProvider;
      merged.defaultModel = DEFAULTS.defaultModel;
    }
    if (typeof localStorage !== "undefined") {
      const rightWidth = legacySize("rightPanel.width");
      const terminalHeight = legacySize("terminalDock.height");
      const hasStoredBottom = Number.isFinite(parsed.regionSizes?.bottom);
      if (rightWidth !== undefined) merged.regionSizes.right = rightWidth;
      if (terminalHeight !== undefined && !hasStoredBottom) merged.regionSizes.bottom = terminalHeight;
      if (rightWidth !== undefined) localStorage.removeItem("rightPanel.width");
      localStorage.setItem(KEY, JSON.stringify(persistedPrefs(merged)));
    }
    return merged;
  } catch {
    return { ...DEFAULTS };
  }
}

const [state, setState] = createStore<Prefs>(load());

function persist() {
  try {
    if (typeof localStorage === "undefined") return;
    localStorage.setItem(
      KEY,
      JSON.stringify(persistedPrefs(state)),
    );
  } catch {
    // best-effort; a private-mode / quota failure just means it won't persist
  }
}

export const prefsStore = {
  state,

  isPinned(workspace: string): boolean {
    return state.pinnedWorkspaces.includes(workspace);
  },

  togglePinned(workspace: string) {
    const pinned = state.pinnedWorkspaces.includes(workspace)
      ? state.pinnedWorkspaces.filter((name) => name !== workspace)
      : [...state.pinnedWorkspaces, workspace];
    setState("pinnedWorkspaces", pinned);
    persist();
  },

  /** Set the default model for new chats. Provider is derived from the model. */
  setDefaultModel(model: string) {
    const provider = providerForModel(model) ?? state.defaultProvider;
    setState({ defaultProvider: provider, defaultModel: model });
    persist();
  },

  setTheme(theme: ThemeMode) {
    setState("theme", theme);
    persist();
  },

  setAccent(accent: Accent) {
    setState("accent", accent);
    persist();
  },

  setDensity(density: Density) {
    setState("density", density);
    persist();
  },

  setSidebarCollapsed(collapsed: boolean) {
    setState("sidebarCollapsed", collapsed);
    persist();
  },

  setActivePresetId(activePresetId: string) {
    setState("activePresetId", activePresetId);
    persist();
  },

  setRegionSize(region: Region, size: number) {
    setState("regionSizes", region, clampRegionSize(region, size));
    persist();
  },

  setCollapsedRegions(collapsedRegions: Region[]) {
    setState("collapsedRegions", [...new Set(collapsedRegions)]);
    persist();
  },

  setRegionCollapsed(region: Region, collapsed: boolean) {
    const regions = new Set(state.collapsedRegions);
    collapsed ? regions.add(region) : regions.delete(region);
    setState("collapsedRegions", [...regions]);
    persist();
  },

  setKeybindings(keybindings: string) {
    setState("keybindings", keybindings);
    persist();
  },

  /** The model a new chat on `provider` should start with. Falls back to the
   *  provider's first model so every new chat has a concrete model. */
  seedModelFor(provider: string): string {
    if (provider === state.defaultProvider && MODELS[provider]?.includes(state.defaultModel)) {
      return state.defaultModel;
    }
    return firstModel(provider);
  },

  chatProviders: CHAT_PROVIDERS,
};
