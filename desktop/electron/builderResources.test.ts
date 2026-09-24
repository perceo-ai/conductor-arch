import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const desktopRoot = path.resolve(__dirname, "..");
const builderConfig = fs.readFileSync(path.join(desktopRoot, "electron-builder.yml"), "utf8");

type Resource = { from: string; to: string };

function resourceBlock(section?: string): Resource[] {
  const start = section ? builderConfig.indexOf(`\n${section}:\n`) : 0;
  expect(start).toBeGreaterThanOrEqual(0);

  const sectionText = section
    ? builderConfig.slice(start, builderConfig.indexOf("\n\n", start))
    : builderConfig.slice(0, builderConfig.indexOf("\nlinux:\n"));
  const blockStart = section
    ? sectionText.indexOf("\n  extraResources:\n")
    : sectionText.indexOf("\nextraResources:\n");
  if (blockStart < 0) return [];

  const block = sectionText.slice(blockStart).split("\n");
  const resources: Resource[] = [];
  let current: Partial<Resource> | undefined;

  for (const line of block) {
    const from = line.match(/^\s+- from: (.+)$/);
    if (from) {
      current = { from: from[1] };
      resources.push(current as Resource);
      continue;
    }
    const to = line.match(/^\s+to: (.+)$/);
    if (to && current) current.to = to[1];
  }

  return resources;
}

describe("electron-builder resource packaging", () => {
  it("does not merge missing Unix sidecars or duplicate icons into Windows packages", () => {
    const common = resourceBlock();
    const windows = resourceBlock("win");
    const mergedWindows = [...common, ...windows];

    expect(common.map((resource) => resource.from)).toEqual(["build/icon.png", "build/icon.ico"]);

    expect(mergedWindows.map((resource) => resource.from)).not.toContain("../target/release/archcar");
    expect(mergedWindows.map((resource) => resource.from)).not.toContain(
      "../target/release/archductor",
    );

    expect(windows.map((resource) => resource.from)).toEqual([
      "../target/release/archcar.exe",
      "../target/release/archductor.exe",
    ]);

    const destinations = mergedWindows.map((resource) => resource.to);
    expect(destinations).toEqual([...new Set(destinations)]);
  });
});
