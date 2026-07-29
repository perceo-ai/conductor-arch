import { defineConfig } from "vite";
import path from "node:path";
import solid from "vite-plugin-solid";
import electron from "vite-plugin-electron";
import renderer from "vite-plugin-electron-renderer";

// UI-only Electron rewrite of gtk-app. Renderer = Solid (fine-grained reactivity);
// main process bridges to the Rust archcar daemon over its Unix socket.
export default defineConfig({
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
        entry: "electron/preload.ts",
        onstart(args) {
          args.reload();
        },
        vite: {
          build: { outDir: "dist-electron" },
        },
      },
    ]),
    renderer(),
  ],
});
