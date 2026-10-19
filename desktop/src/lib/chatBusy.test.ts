// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  activeSubagentCount,
  createGenerationEdgeDetector,
  isChatGenerating,
  type ChatBusyInput,
} from "./chatBusy";

const STREAMING = { runtime_state: "streaming", ready: false };
const TOOL = { runtime_state: "tool_running", ready: false };
const READY = { runtime_state: "idle", ready: true };

const subagent = (status: string) => ({ render_class: "subagent_card", status });
const nested = (status: string) => ({ render_class: "nested_transcript_card", status });
const tool = (status: string) => ({ render_class: "tool_card", status });

function input(over: Partial<ChatBusyInput>): ChatBusyInput {
  return { session: READY, phase: { kind: "ready" }, blockedOnUser: false, projection: [], ...over };
}

/** Feed a sequence of chat states through one detector; return the edges fired. */
function edgesFor(states: ChatBusyInput[], threadId = 1): boolean[] {
  const d = createGenerationEdgeDetector();
  return states.map((s) => d.observe(threadId, isChatGenerating(s)));
}

describe("activeSubagentCount", () => {
  it("ignores a subagent's prompt row, which the daemon never closes", () => {
    // The shape main's projection gives a finished Claude subagent
    // (core fixture subagents_and_background_tasks.jsonl).
    const agent = "claude:sess_tasks:toolu_agent";
    const finished = [
      { render_class: "subagent_card", status: "running", parent_id: agent },
      { render_class: "command_card", status: "complete", parent_id: agent },
      { render_class: "nested_transcript_card", status: "complete", parent_id: agent },
      { render_class: "tool_card", status: "complete", parent_id: null },
    ];
    expect(activeSubagentCount(finished)).toBe(0);
    expect(isChatGenerating(input({ session: READY, projection: finished }))).toBe(false);
    // Its report still streaming is real subagent work.
    const streaming = finished.map((item) =>
      item.render_class === "nested_transcript_card" ? { ...item, status: "running" } : item,
    );
    expect(activeSubagentCount(streaming)).toBe(1);
  });

  it("counts only running subagent and nested-transcript cards", () => {
    expect(
      activeSubagentCount([
        subagent("running"),
        nested("running"),
        subagent("complete"),
        subagent("failed"),
        subagent("pending"),
        tool("running"),
      ]),
    ).toBe(2);
  });
});

describe("isChatGenerating", () => {
  it("main only: busy while streaming or tool-calling, idle when ready", () => {
    expect(isChatGenerating(input({ session: STREAMING }))).toBe(true);
    expect(isChatGenerating(input({ session: TOOL }))).toBe(true);
    expect(isChatGenerating(input({ session: READY }))).toBe(false);
  });

  it("subagent only: a ready main agent with a running subagent is still generating", () => {
    expect(isChatGenerating(input({ session: READY, projection: [subagent("running")] }))).toBe(true);
    expect(isChatGenerating(input({ session: READY, projection: [subagent("complete")] }))).toBe(false);
  });

  it("an agent blocked on the user is idle unless a subagent is still working", () => {
    expect(isChatGenerating(input({ session: STREAMING, blockedOnUser: true }))).toBe(false);
    expect(
      isChatGenerating(input({ session: STREAMING, blockedOnUser: true, projection: [subagent("running")] })),
    ).toBe(true);
  });

  it("ignores subagent cards once the session is gone, so a dead chat cannot stay busy", () => {
    expect(isChatGenerating(input({ session: null, projection: [subagent("running")] }))).toBe(false);
  });
});

describe("falling edge over main agent + subagents", () => {
  it("main only: fires once when the turn ends", () => {
    expect(edgesFor([input({ session: STREAMING }), input({ session: TOOL }), input({ session: READY })])).toEqual(
      [false, false, true],
    );
  });

  it("main done but subagent still running: does not fire until the subagent completes", () => {
    expect(
      edgesFor([
        input({ session: STREAMING, projection: [subagent("running")] }),
        // Main agent's turn ends; the background subagent is still going.
        input({ session: READY, projection: [subagent("running")] }),
        input({ session: READY, projection: [subagent("complete")] }),
      ]),
    ).toEqual([false, false, true]);
  });

  it("last subagent finishes while main is still working: does not fire until main is done", () => {
    expect(
      edgesFor([
        input({ session: STREAMING, projection: [subagent("running")] }),
        input({ session: STREAMING, projection: [subagent("complete")] }),
        input({ session: READY, projection: [subagent("complete")] }),
      ]),
    ).toEqual([false, false, true]);
  });

  it("subagent only: a background subagent finishing after the main turn fires once", () => {
    expect(
      edgesFor([
        input({ session: READY, projection: [subagent("running")] }),
        input({ session: READY, projection: [subagent("complete")] }),
      ]),
    ).toEqual([false, true]);
  });

  it("nested finishes: fires only when the last of several subagents completes", () => {
    expect(
      edgesFor([
        input({ session: READY, projection: [subagent("running"), subagent("running"), nested("running")] }),
        input({ session: READY, projection: [subagent("complete"), subagent("running"), nested("running")] }),
        input({ session: READY, projection: [subagent("complete"), subagent("running"), nested("complete")] }),
        input({ session: READY, projection: [subagent("complete"), subagent("failed"), nested("complete")] }),
      ]),
    ).toEqual([false, false, false, true]);
  });

  it("dedupes: re-renders, refreshes and reconnects of an idle chat never fire again", () => {
    expect(
      edgesFor([
        input({ session: STREAMING }),
        input({ session: READY }),
        input({ session: READY }),
        input({ session: READY, projection: [subagent("complete")] }),
        input({ session: null }),
      ]),
    ).toEqual([false, true, false, false, false]);
  });

  it("never fires on the first observation, even of an idle chat", () => {
    expect(edgesFor([input({ session: READY })])).toEqual([false]);
  });

  it("fires once per busy period across consecutive turns", () => {
    expect(
      edgesFor([
        input({ session: STREAMING }),
        input({ session: READY }),
        input({ session: STREAMING }),
        input({ session: READY }),
      ]),
    ).toEqual([false, true, false, true]);
  });

  it("tracks chats independently", () => {
    const d = createGenerationEdgeDetector();
    expect(d.observe(1, true)).toBe(false);
    expect(d.observe(2, true)).toBe(false);
    expect(d.observe(1, false)).toBe(true);
    expect(d.observe(2, true)).toBe(false);
    expect(d.observe(2, false)).toBe(true);
  });
});
