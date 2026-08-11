import { describe, expect, it } from "vitest";
import { compareVersions, updateStatusText } from "./update";

describe("update helpers", () => {
  it("compares semver releases with v-prefixes", () => {
    expect(compareVersions("v0.4.1", "0.4.0")).toBeGreaterThan(0);
    expect(compareVersions("0.4.0", "v0.4.0")).toBe(0);
    expect(compareVersions("0.4.0", "0.4.1")).toBeLessThan(0);
  });

  it("describes current and available update states", () => {
    expect(updateStatusText({ currentVersion: "0.4.0" })).toBe("Current version 0.4.0");
    expect(updateStatusText({ currentVersion: "0.4.0", latestVersion: "0.4.1", updateAvailable: true })).toBe(
      "Update available: 0.4.1",
    );
    expect(updateStatusText({ currentVersion: "0.4.0", latestVersion: "0.4.0", updateAvailable: false })).toBe(
      "Archductor is up to date.",
    );
  });
});
