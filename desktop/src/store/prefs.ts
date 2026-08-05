import { createStore } from "solid-js/store";
import { CHAT_PROVIDERS, MODELS, firstModel, providerForModel } from "@/lib/models";

// Renderer-local user preferences, persisted to localStorage. Kept out of the
// archcar TOML settings on purpose: these are per-machine UI defaults (which
// model a brand-new chat starts on), not project config, so they don't need to
// round-trip through the daemon.

const KEY = "archductor.prefs.v1";

export interface Prefs {
  // Provider + model a newly created chat is seeded with.
  defaultProvider: string;
  defaultModel: string;
}

const DEFAULTS: Prefs = { defaultProvider: "codex", defaultModel: firstModel("codex") };

function load(): Prefs {
  try {
    const raw = typeof localStorage !== "undefined" ? localStorage.getItem(KEY) : null;
    if (!raw) return { ...DEFAULTS };
    const parsed = JSON.parse(raw) as Partial<Prefs>;
    const merged = { ...DEFAULTS, ...parsed };
    // Drop stale values if the model list changed between versions.
    if (!MODELS[merged.defaultProvider]?.includes(merged.defaultModel)) {
      return { ...DEFAULTS };
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
      JSON.stringify({ defaultProvider: state.defaultProvider, defaultModel: state.defaultModel }),
    );
  } catch {
    // best-effort; a private-mode / quota failure just means it won't persist
  }
}

export const prefsStore = {
  state,

  /** Set the default model for new chats. Provider is derived from the model. */
  setDefaultModel(model: string) {
    const provider = providerForModel(model) ?? state.defaultProvider;
    setState({ defaultProvider: provider, defaultModel: model });
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
