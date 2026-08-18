import { describe, expect, it } from "vitest";
import { inlineEventVerbChip } from "./chatFormat";

describe("inlineEventVerbChip", () => {
  it("renders read-only shell wrappers as Read events", () => {
    expect(inlineEventVerbChip("command_card", `Ran /bin/zsh -lc "sed -n '1,80p' AGENTS.md progress.md"`)).toEqual({
      verb: "Read",
      chip: "AGENTS.md, progress.md",
    });
    expect(inlineEventVerbChip("command_card", `/bin/zsh -lc "sed -n '1,80p' AGENTS.md progress.md"`)).toEqual({
      verb: "Read",
      chip: "AGENTS.md, progress.md",
    });
  });

  it("keeps mutating commands as Ran events", () => {
    expect(inlineEventVerbChip("command_card", "Ran cargo fmt --all")).toEqual({
      verb: "Ran",
      chip: "cargo fmt --all",
    });
  });

  it("renders provider file-read titles as Read events", () => {
    expect(inlineEventVerbChip("file_card", "Read README.md")).toEqual({
      verb: "Read",
      chip: "README.md",
    });
  });
});
