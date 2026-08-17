import { describe, expect, it } from "vitest";
import { fileIconFor } from "./fileIconKind";

describe("fileIconFor", () => {
  it("uses language-specific icons for common source files", () => {
    expect(fileIconFor("desktop/src/pages/WorkspaceFiles.tsx")).toMatchObject({
      label: "TSX",
      kind: "typescript",
    });
    expect(fileIconFor("crates/archcar/src/main.rs")).toMatchObject({
      label: "RS",
      kind: "rust",
    });
  });

  it("uses package and lockfile icons for project manifests", () => {
    expect(fileIconFor("desktop/package.json")).toMatchObject({
      label: "PKG",
      kind: "package",
    });
    expect(fileIconFor("Cargo.lock")).toMatchObject({
      label: "RS",
      kind: "lock",
    });
  });

  it("falls back to config and generic file icons", () => {
    expect(fileIconFor(".codex/settings")).toMatchObject({
      label: "CFG",
      kind: "config",
    });
    expect(fileIconFor("unknown")).toMatchObject({
      label: "",
      kind: "file",
    });
  });
});
