// @vitest-environment node
import { describe, expect, it } from "vitest";
import { composerDrafts } from "./composerDrafts";

describe("composerDrafts", () => {
  it("keeps a draft per thread and forgets an emptied one", () => {
    composerDrafts.save(1, [{ kind: "text", text: "half a prompt" }]);
    composerDrafts.save(2, [{ kind: "text", text: "other chat" }]);
    expect(composerDrafts.get(1)).toEqual([{ kind: "text", text: "half a prompt" }]);
    expect(composerDrafts.get(2)).toEqual([{ kind: "text", text: "other chat" }]);
    composerDrafts.save(1, []);
    expect(composerDrafts.get(1)).toEqual([]);
    expect(composerDrafts.get(3)).toEqual([]);
  });
});
