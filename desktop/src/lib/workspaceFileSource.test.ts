import { describe, expect, it } from "vitest";
import { preferArchcarWorkspaceFileList } from "./workspaceFileSource";

describe("preferArchcarWorkspaceFileList", () => {
  it("keeps local file listing for local archcar speed", () => {
    expect(preferArchcarWorkspaceFileList({ remoteAddress: null, rootPath: "/repo/ws" })).toBe(false);
  });

  it("uses archcar first for remote clients because server paths are not local", () => {
    expect(preferArchcarWorkspaceFileList({ remoteAddress: "devbox:7420", rootPath: "/srv/repo/ws" })).toBe(true);
  });
}
);
