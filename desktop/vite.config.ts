import { defineConfig } from "vite";
import path from "node:path";
import solid from "vite-plugin-solid";
import electron from "vite-plugin-electron";
import renderer from "vite-plugin-electron-renderer";

// UI-only Electron rewrite of gtk-app. Renderer = Solid (fine-grained reactivity);
// main process bridges to the Rust archcar daemon over its Unix socket.
export default defineConfig({
  // Relative asset paths so the renderer loads under file:// in a packaged
  // build (loadFile). Absolute "/" paths 404 outside a dev server.
  base: "./",
  resolve: {
    alias: { "@": path.resolve(__dirname, "src") },
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
        // Electron loads preload scripts via CommonJS require(), so it MUST be
        // emitted as CJS (.cjs) — an ESM preload fails with ERR_REQUIRE_ESM and
        // leaves window.archductor undefined.
        entry: "electron/preload.ts",
        onstart(args) {
          args.reload();
        },
        vite: {
          build: {
            outDir: "dist-electron",
            // lib mode with a single cjs format forces genuine CommonJS output
            // (import → require), which Electron's preload loader requires.
            lib: {
              entry: "electron/preload.ts",
              formats: ["cjs"],
              fileName: () => "preload.cjs",
            },
            rollupOptions: { external: ["electron"] },
          },
        },
      },
    ]),
    renderer(),
  ],
});
