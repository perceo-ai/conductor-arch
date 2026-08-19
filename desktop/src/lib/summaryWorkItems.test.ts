import { describe, expect, it } from "vitest";
import { mergeWorkItems } from "./summaryWorkItems";
import type { Task, Todo } from "@/bridge/protocol";

function task(over: Partial<Task> & Pick<Task, "id" | "title" | "status">): Task {
  return {
    workspace_id: 1,
    body: "",
    intended_areas: [],
    review_notes: "",
    linked_session_ids: [],
    created_at: "2026-08-19T10:00:00Z",
    updated_at: "2026-08-19T10:00:00Z",
    ...over,
  };
}

function todo(over: Partial<Todo> & Pick<Todo, "id" | "text" | "status">): Todo {
  return {
    workspace_id: 1,
    source: "manual",
    created_at: "2026-08-19T10:00:00Z",
    updated_at: "2026-08-19T10:00:00Z",
    ...over,
  };
}

describe("mergeWorkItems", () => {
  it("returns one flat list from both sources", () => {
    const items = mergeWorkItems(
      [task({ id: 3, title: "Port the panel", status: "in_progress" })],
      [todo({ id: 7, text: "delete dead CSS", status: "open" })],
    );
    expect(items.map((i) => [i.kind, i.title])).toEqual([
      ["task", "Port the panel"],
      ["todo", "delete dead CSS"],
    ]);
  });

  it("keys rows per source so task #1 and todo #1 cannot collide", () => {
    const items = mergeWorkItems(
      [task({ id: 1, title: "a", status: "todo" })],
      [todo({ id: 1, text: "b", status: "open" })],
    );
    expect(new Set(items.map((i) => i.key)).size).toBe(2);
  });

  it("normalizes todo statuses into the task vocabulary", () => {
    const items = mergeWorkItems(
      [],
      [todo({ id: 1, text: "a", status: "open" }), todo({ id: 2, text: "b", status: "done" })],
    );
    expect(items.map((i) => i.status)).toEqual(["todo", "done"]);
  });

  it("sorts unfinished work first and finished work last", () => {
    const items = mergeWorkItems(
      [
        task({ id: 1, title: "done", status: "done" }),
        task({ id: 2, title: "todo", status: "todo" }),
        task({ id: 3, title: "blocked", status: "blocked" }),
        task({ id: 4, title: "review", status: "review" }),
        task({ id: 5, title: "running", status: "in_progress" }),
      ],
      [todo({ id: 9, text: "open todo", status: "open" })],
    );
    expect(items.map((i) => i.title)).toEqual([
      "blocked",
      "running",
      "review",
      "todo",
      "open todo",
      "done",
    ]);
  });

  it("maps status onto the shared check-glyph tones", () => {
    const items = mergeWorkItems(
      [
        task({ id: 1, title: "a", status: "blocked" }),
        task({ id: 2, title: "b", status: "in_progress" }),
        task({ id: 3, title: "c", status: "review" }),
        task({ id: 4, title: "d", status: "todo" }),
        task({ id: 5, title: "e", status: "done" }),
      ],
      [],
    );
    expect(items.map((i) => i.tone)).toEqual([
      "failed",
      "running",
      "running",
      "unknown",
      "passed",
    ]);
  });

  it("folds owner and intended areas into one muted detail line", () => {
    const [item] = mergeWorkItems(
      [
        task({
          id: 1,
          title: "a",
          status: "todo",
          owner: "pranav",
          intended_areas: ["desktop", "core"],
        }),
      ],
      [],
    );
    expect(item.detail).toBe("pranav · desktop, core");
  });

  it("omits absent owner and areas rather than leaving separators", () => {
    const [owned, bare] = mergeWorkItems(
      [
        task({ id: 1, title: "a", status: "todo", owner: "pranav" }),
        task({ id: 2, title: "b", status: "todo", owner: null }),
      ],
      [],
    );
    expect(owned.detail).toBe("pranav");
    expect(bare.detail).toBe("");
  });

  // Todos synced out of chat are agent-authored; saying so is the only thing
  // that distinguishes them from a line the human typed.
  it("labels context-sourced todos", () => {
    const [fromChat, manual] = mergeWorkItems(
      [],
      [
        todo({ id: 1, text: "a", status: "open", source: "context" }),
        todo({ id: 2, text: "b", status: "open", source: "manual" }),
      ],
    );
    expect(fromChat.detail).toBe("from chat");
    expect(manual.detail).toBe("");
  });

  it("carries the blocked reason through", () => {
    const [item] = mergeWorkItems(
      [task({ id: 1, title: "a", status: "blocked", blocked_reason: "waiting on review" })],
      [],
    );
    expect(item.blockedReason).toBe("waiting on review");
  });

  it("handles both sides being empty", () => {
    expect(mergeWorkItems([], [])).toEqual([]);
  });
});
