// @vitest-environment node
import { describe, expect, it } from "vitest";
import { editorDraftStash } from "./editorDraftStash";

describe("editorDraftStash", () => {
  it("parks dirty text per workspace:path and takes it back once", () => {
    editorDraftStash.park("local", "ws-a", "src/x.ts", "edited");
    editorDraftStash.park("local", "ws-b", "src/x.ts", "other tree");
    expect(editorDraftStash.take("local", "ws-a", "src/x.ts")).toBe("edited");
    expect(editorDraftStash.take("local", "ws-a", "src/x.ts")).toBeNull();
    expect(editorDraftStash.take("local", "ws-b", "src/x.ts")).toBe("other tree");
  });

  it("clean park and clear both drop the entry", () => {
    editorDraftStash.park("local", "ws", "f", "text");
    editorDraftStash.park("local", "ws", "f", null);
    expect(editorDraftStash.take("local", "ws", "f")).toBeNull();
    editorDraftStash.park("local", "ws", "f", "text");
    editorDraftStash.clear("local", "ws", "f");
    expect(editorDraftStash.take("local", "ws", "f")).toBeNull();
  });

  it("does not hand one daemon's draft to the same workspace:path on another daemon", () => {
    editorDraftStash.park("daemon-a", "ws", "f", "from A");
    expect(editorDraftStash.take("daemon-b", "ws", "f")).toBeNull();
    // The wrong-realm take neither returned nor deleted daemon-a's entry.
    expect(editorDraftStash.take("daemon-a", "ws", "f")).toBe("from A");
  });

  it("a save on another daemon does not clear this daemon's draft", () => {
    editorDraftStash.park("daemon-a", "ws", "f", "from A");
    editorDraftStash.clear("daemon-b", "ws", "f");
    expect(editorDraftStash.take("daemon-a", "ws", "f")).toBe("from A");
  });
});
