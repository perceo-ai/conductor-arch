// Guards the macOS signing + notarization contract. Squirrel.Mac only
// self-updates a signed, notarized bundle downloaded as a zip — if any of
// these settings disappear, packaged macOS apps silently lose self-update.
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const desktopRoot = path.resolve(__dirname, "..");
const builderConfig = fs.readFileSync(path.join(desktopRoot, "electron-builder.yml"), "utf8");
const macBlock = builderConfig.slice(builderConfig.indexOf("\nmac:"));

describe("macOS signing configuration", () => {
  it("hardens the runtime and notarizes", () => {
    expect(macBlock).toContain("hardenedRuntime: true");
    expect(macBlock).toContain("notarize: true");
  });

  it("builds a zip target, which Squirrel.Mac updates from", () => {
    expect(macBlock).toContain("- zip");
    expect(macBlock).toContain("- dmg");
  });

  it("ships entitlements that keep Electron's JIT working under hardened runtime", () => {
    expect(macBlock).toContain("entitlements: build/entitlements.mac.plist");
    expect(macBlock).toContain("entitlementsInherit: build/entitlements.mac.plist");

    const plist = fs.readFileSync(path.join(desktopRoot, "build/entitlements.mac.plist"), "utf8");
    for (const key of [
      "com.apple.security.cs.allow-jit",
      "com.apple.security.cs.allow-unsigned-executable-memory",
      "com.apple.security.cs.allow-dyld-environment-variables",
      "com.apple.security.cs.disable-library-validation",
    ]) {
      expect(plist).toContain(key);
    }
  });

  it("release workflow uploads the zip + mac feed and passes notarization env", () => {
    const workflow = fs.readFileSync(
      path.resolve(desktopRoot, "../.github/workflows/desktop-release.yml"),
      "utf8",
    );
    expect(workflow).toContain("desktop/release/*.zip");
    for (const secret of [
      "CSC_LINK",
      "CSC_KEY_PASSWORD",
      "APPLE_ID",
      "APPLE_APP_SPECIFIC_PASSWORD",
      "APPLE_TEAM_ID",
    ]) {
      expect(workflow).toContain(secret);
    }
  });
});
