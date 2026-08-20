import { describe, expect, it } from "vitest";
import { materialFileIcon, materialFolderIcon } from "./materialFileIcons";

describe("material file icons", () => {
  it("resolves real packaged SVGs for language files", () => {
    expect(materialFileIcon("desktop/src/pages/WorkspaceFiles.tsx")).toMatchObject({
      title: "react_ts",
    });
    expect(materialFileIcon("crates/archcar/src/main.rs")).toMatchObject({
      title: "rust",
    });
    expect(materialFileIcon("Cargo.toml").src).toContain(".svg");
  });

  it("uses closed and open folder SVGs instead of disclosure arrows", () => {
    expect(materialFolderIcon("desktop", false)).toMatchObject({ title: "folder-desktop" });
    expect(materialFolderIcon("desktop", true)).toMatchObject({ title: "folder-desktop-open" });
  });
});
