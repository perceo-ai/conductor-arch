import { describe, expect, it } from "vitest";
import { formatActionCount, formatReasoningText, inlineEventVerbChip, isSubagentAction } from "./chatFormat";

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

  it("renders Codex reasoning summaries as muted plain text", () => {
    expect(
      formatReasoningText(
        "**Summarizing live DB lock and timeout findings**\n\n**Investigating queue logs**",
      ),
    ).toBe("Summarizing live DB lock and timeout findings\n\nInvestigating queue logs");
  });
});

describe("background task cards", () => {
  it("label the task by what it is doing", () => {
    expect(inlineEventVerbChip("background_card", "Run the test suite")).toEqual({
      verb: "Background",
      chip: "Run the test suite",
    });
  });
});

describe("subagent cards", () => {
  it("read as the agent asking its subagent", () => {
    expect(inlineEventVerbChip("subagent_card", "Asked subagent")).toEqual({
      verb: "Asked",
      chip: "subagent",
    });
  });
});

describe("formatActionCount", () => {
  it("counts a subagent's actions for the collapsed card header", () => {
    expect(formatActionCount(1)).toBe("1 action");
    expect(formatActionCount(12)).toBe("12 actions");
    expect(formatActionCount(0)).toBe("0 actions");
  });
});

describe("isSubagentAction", () => {
  it("counts what a subagent did, not what it said or was asked", () => {
    const row = (render_class: string, title: string) => ({ render_class, title });
    expect(isSubagentAction(row("command_card", "Bash ls"))).toBe(true);
    expect(isSubagentAction(row("tool_card", "Agent Dig deeper"))).toBe(true);
    // A Codex spawn/wait is a subagent card too, and is an action.
    expect(isSubagentAction(row("subagent_card", "spawn_agent"))).toBe(true);
    expect(isSubagentAction(row("subagent_card", "Asked subagent"))).toBe(false);
    expect(isSubagentAction(row("nested_transcript_card", "Subagent"))).toBe(false);
    expect(isSubagentAction(row("assistant_chat", ""))).toBe(false);
  });
});
