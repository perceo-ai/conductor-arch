import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveWindowIconPath } from "./icon";
import { alphaAt, decodePng, isPng, minimumAlpha, parseIcns } from "./iconAssets";

const desktopRoot = path.resolve(__dirname, "..");

describe("desktop icon packaging", () => {
  it("ships platform package icons from build resources", () => {
    expect(fs.existsSync(path.join(desktopRoot, "build/icon.png"))).toBe(true);
    expect(fs.existsSync(path.join(desktopRoot, "build/icon.ico"))).toBe(true);
    expect(fs.existsSync(path.join(desktopRoot, "build/icon.icns"))).toBe(true);

    const builderConfig = fs.readFileSync(path.join(desktopRoot, "electron-builder.yml"), "utf8");
    expect(builderConfig).toContain("icon: build/icon.icns");
    expect(builderConfig).toContain("icon: build/icon.png");
    expect(builderConfig).toContain("icon: build/icon.ico");
    expect(builderConfig).toContain("to: icon.png");
  });

  it("keeps the macOS master opaque and drawn edge to edge", () => {
    const master = decodePng(fs.readFileSync(path.join(desktopRoot, "build/icon-macos.png")));

    expect(master.width).toBe(1024);
    expect(master.height).toBe(1024);
    // Rounded corners or a transparent margin would make macOS 26+ mount the
    // artwork on its own pale rounded plate instead of masking ours.
    expect(minimumAlpha(master)).toBe(255);
    for (const [x, y] of [
      [0, 0],
      [master.width - 1, 0],
      [0, master.height - 1],
      [master.width - 1, master.height - 1],
    ]) {
      expect(alphaAt(master, x, y)).toBe(255);
    }
  });

  it("builds every icns size from the opaque macOS master", () => {
    const entries = parseIcns(fs.readFileSync(path.join(desktopRoot, "build/icon.icns")));

    // ic10 is the 1024px slot macOS wants for Retina Dock and Finder previews.
    expect([...entries.keys()]).toContain("ic10");

    for (const [type, entry] of entries) {
      if (!isPng(entry)) continue;
      const image = decodePng(entry);
      expect(`${type}:${minimumAlpha(image)}`).toBe(`${type}:255`);
    }
  });

  it("resolves a packaged runtime icon before falling back to the source build icon", () => {
    const existing = new Set([
      path.join("/Applications/Archductor.app/Contents/Resources", "icon.png"),
      path.join("/repo/desktop/build", "icon.png"),
    ]);
    const icon = resolveWindowIconPath({
      moduleDir: "/Applications/Archductor.app/Contents/Resources/app.asar/dist-electron",
      resourcesPath: "/Applications/Archductor.app/Contents/Resources",
      platform: "linux",
      exists: (candidate) => existing.has(candidate),
    });

    expect(icon).toBe(path.join("/Applications/Archductor.app/Contents/Resources", "icon.png"));
  });
});
