import viteConfig from "./vite.config";

/**
 * Vitest config, kept separate from vite.config.ts on purpose.
 *
 * Importing `defineConfig` from "vitest/config" pulls in vitest's bundled copy
 * of vite's types, which disagrees with vite 6's `Plugin` type and breaks
 * `tsc --noEmit` on the electron plugin. Reusing the vite config as a plain
 * object sidesteps that: the alias, the solid plugin and the VITEST-guarded
 * resolve conditions all still apply, and only the test block lives here.
 *
 * Excluded from tsconfig's `include` for the same reason — nothing else imports
 * it, and vitest reads it directly.
 */
export default {
  ...viteConfig,
  test: {
    // Most tests are pure and opt into `// @vitest-environment node`; component
    // tests need a DOM, so jsdom is the default.
    environment: "jsdom",
    // Solid must be transformed by its plugin rather than loaded pre-bundled,
    // or its JSX runtime and the compiled components disagree at runtime.
    server: { deps: { inline: [/solid-js/] } },
  },
};
