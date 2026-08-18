import { describe, expect, it } from "vitest";
import { WORKSPACE_OPEN_APPS, workspaceDefaultOpener } from "./workspaceOpenApps";

describe("workspace open apps", () => {
  it("uses packaged SVG logos for editor apps", () => {
    expect(WORKSPACE_OPEN_APPS.map((app) => app.id)).toEqual(["cursor", "vscode"]);
    for (const app of WORKSPACE_OPEN_APPS) {
      expect(app.logoSrc).toContain(".svg");
    }
  });

  it("uses a platform-aware packaged logo for the default file manager", () => {
    expect(workspaceDefaultOpener("Macintosh")).toMatchObject({ label: "Finder" });
    expect(workspaceDefaultOpener("Windows")).toMatchObject({ label: "File Explorer" });
    expect(workspaceDefaultOpener("Linux")).toMatchObject({ label: "File manager" });
    expect(workspaceDefaultOpener("Linux").logoSrc).toContain(".svg");
  });
});
