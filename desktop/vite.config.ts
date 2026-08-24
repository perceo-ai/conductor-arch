import { defineConfig } from "vite";
import path from "node:path";
import solid from "vite-plugin-solid";
import electron from "vite-plugin-electron";

// UI-only Electron rewrite of gtk-app. Renderer = Solid (fine-grained reactivity);
// main process bridges to the Rust archcar daemon over its Unix socket.
export default defineConfig({
  // Relative asset paths so the renderer loads under file:// in a packaged
  // build (loadFile). Absolute "/" paths 404 outside a dev server.
  base: "./",
  resolve: {
    alias: { "@": path.resolve(__dirname, "src") },
    // Vitest transforms TSX through its SSR pipeline even for per-file jsdom
    // tests. Prefer Solid's browser exports there so component regression tests
    // exercise the live DOM renderer instead of the server-only stubs.
    ...(process.env.VITEST ? { conditions: ["browser"] } : {}),
  },
  plugins: [
    solid(),
    electron([
      {
        // Main process.
        entry: "electron/main.ts",
        vite: {
          build: { outDir: "dist-electron" },
        },
      },
      {
        // Preload: exposes a typed, isolated bridge to the renderer.
        // package.json is `"type": "module"`, so forcing CJS output only
        // collapses to real CommonJS when minified (vite build); in serve mode
        // (vite dev, non-minified) esbuild emits ESM `import`/`export` into the
        // file, which a *sandboxed* preload can't load. Instead we align with
        // the module type: emit an ESM `.mjs` preload and load it unsandboxed
        // (contextIsolation stays on). This is deterministic in dev and build.
        entry: "electron/preload.ts",
        onstart(args) {
          args.reload();
        },
        vite: {
          build: {
            outDir: "dist-electron",
            rollupOptions: {
              external: ["electron"],
              output: {
                format: "es",
                entryFileNames: "preload.mjs",
                inlineDynamicImports: true,
              },
            },
          },
        },
      },
    ]),
  ],
});
