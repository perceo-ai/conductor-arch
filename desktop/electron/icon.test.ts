import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveWindowIconPath } from "./icon";

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
