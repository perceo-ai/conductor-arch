// @vitest-environment node
import { describe, expect, it } from "vitest";
import { composerDrafts, draftKey } from "./composerDrafts";

describe("composerDrafts", () => {
  it("keeps a draft per realm-qualified thread and forgets an emptied one", () => {
    composerDrafts.save(draftKey("local", 1), [{ kind: "text", text: "half a prompt" }]);
    composerDrafts.save(draftKey("local", 2), [{ kind: "text", text: "other chat" }]);
    // Same numeric thread id on another daemon is a different conversation.
    composerDrafts.save(draftKey("client:x", 1), [{ kind: "text", text: "remote draft" }]);
    expect(composerDrafts.get(draftKey("local", 1))).toEqual([{ kind: "text", text: "half a prompt" }]);
    expect(composerDrafts.get(draftKey("client:x", 1))).toEqual([{ kind: "text", text: "remote draft" }]);
    composerDrafts.save(draftKey("local", 1), []);
    expect(composerDrafts.get(draftKey("local", 1))).toEqual([]);
    expect(composerDrafts.get(draftKey("client:x", 1))).toEqual([{ kind: "text", text: "remote draft" }]);
    expect(composerDrafts.get(draftKey("local", 3))).toEqual([]);
  });
});
