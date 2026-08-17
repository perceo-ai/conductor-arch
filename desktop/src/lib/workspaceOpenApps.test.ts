import { describe, expect, it } from "vitest";
import { WORKSPACE_OPEN_APPS } from "./workspaceOpenApps";

describe("workspace open apps", () => {
  it("uses packaged SVG logos for editor apps", () => {
    expect(WORKSPACE_OPEN_APPS.map((app) => app.id)).toEqual(["cursor", "vscode"]);
    for (const app of WORKSPACE_OPEN_APPS) {
      expect(app.logoSrc).toContain(".svg");
    }
  });
});
