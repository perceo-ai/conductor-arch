// @vitest-environment node
import { describe, expect, it } from "vitest";
import { editorDraftStash } from "./editorDraftStash";

describe("editorDraftStash", () => {
  it("parks dirty text per workspace:path and takes it back once", () => {
    editorDraftStash.park("ws-a", "src/x.ts", "edited");
    editorDraftStash.park("ws-b", "src/x.ts", "other tree");
    expect(editorDraftStash.take("ws-a", "src/x.ts")).toBe("edited");
    expect(editorDraftStash.take("ws-a", "src/x.ts")).toBeNull();
    expect(editorDraftStash.take("ws-b", "src/x.ts")).toBe("other tree");
  });

  it("clean park and clear both drop the entry", () => {
    editorDraftStash.park("ws", "f", "text");
    editorDraftStash.park("ws", "f", null);
    expect(editorDraftStash.take("ws", "f")).toBeNull();
    editorDraftStash.park("ws", "f", "text");
    editorDraftStash.clear("ws", "f");
    expect(editorDraftStash.take("ws", "f")).toBeNull();
  });
});
