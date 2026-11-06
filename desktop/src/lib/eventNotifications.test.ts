import { describe, expect, it } from "vitest";
import { notificationForArchcarEvent } from "./eventNotifications";
import type { ArchcarEvent } from "@/bridge/protocol";

const interactionEvent: ArchcarEvent = {
  type: "provider_interaction_requested",
  interaction: {
    id: "ask-1",
    provider_key: "claude",
    workspace: "checkout",
    thread_id: 9,
    session_id: 3,
    kind: "permission",
    title: "Approve command?",
    detail: "cargo test",
    questions: [],
    status: "pending",
  },
};

describe("notificationForArchcarEvent", () => {
  const chat = {
    workspace: "antix",
    chatTitle: "fix the parser",
    model: "claude-opus-5",
    provider: "claude",
  };

  it("says where a chat needs you, and what it is asking", () => {
    expect(notificationForArchcarEvent(interactionEvent, chat)).toEqual({
      id: "interaction-ask-1",
      // The interaction's own workspace wins over the looked-up one.
      title: "checkout \u00b7 fix the parser",
      body: "Needs you: Approve command? \u2014 cargo test",
    });
  });

  it("says where a turn ended, how it ended, how long it took and who ran it", () => {
    const turn = (status: string, duration_ms?: number) =>
      notificationForArchcarEvent(
        { type: "turn_completed", session_id: 11, thread_id: 9, status, duration_ms },
        chat,
      );

    expect(turn("success", 252_000)).toEqual({
      // Keyed on the status, so a retried turn replaces its own banner.
      id: "turn-11-9-success",
      title: "antix \u00b7 fix the parser",
      body: "Done in 4m 12s \u00b7 Claude Opus 5",
    });
    expect(turn("failed", 2_000)?.body).toBe("Failed after 2.0s \u00b7 Claude Opus 5");
    expect(turn("interrupted", 18_300)?.body).toBe("Stopped after 18.3s \u00b7 Claude Opus 5");
    // An older daemon sends no duration; the outcome still reads.
    expect(turn("success")?.body).toBe("Done \u00b7 Claude Opus 5");
    // An unknown status is shown, not flattened into "stopped".
    expect(turn("rate_limited", 900)?.body).toBe("Rate_limited after 900ms \u00b7 Claude Opus 5");
  });

  it("falls back through the context it has", () => {
    const event: ArchcarEvent = {
      type: "turn_completed",
      session_id: 11,
      thread_id: 9,
      status: "success",
      duration_ms: 1_500,
    };
    // No model recorded: the provider names who ran the turn.
    expect(notificationForArchcarEvent(event, { ...chat, model: null })?.body).toBe(
      "Done in 1.5s \u00b7 Claude",
    );
    // Nothing loaded: the thread number is the last resort, as before.
    expect(notificationForArchcarEvent(event)).toEqual({
      id: "turn-11-9-success",
      title: "Thread 9",
      body: "Done in 1.5s",
    });
    expect(notificationForArchcarEvent(event, { workspace: "  " })?.title).toBe("Thread 9");
  });

  it("cuts a long title at a word boundary and flattens a multi-line error", () => {
    expect(
      notificationForArchcarEvent(
        { type: "turn_completed", session_id: 1, thread_id: 2, status: "success", duration_ms: 1_000 },
        {
          workspace: "antix",
          chatTitle: "refactor the provider projection so every surface agrees on turn ids",
        },
      )?.title,
    ).toBe("antix \u00b7 refactor the provider projection so every\u2026");

    expect(
      notificationForArchcarEvent(
        {
          type: "session_error",
          session_id: 11,
          thread_id: 9,
          message: "codex exited\n\n  before it was ready",
        },
        chat,
      ),
    ).toEqual({
      id: "session-error-11-9",
      title: "antix \u00b7 fix the parser",
      body: "Failed: codex exited before it was ready",
    });
  });

  it("keeps background task settled notifications", () => {
    expect(
      notificationForArchcarEvent({
        type: "background_task_updated",
        task: {
          id: 4,
          repository_name: "repo",
          workspace_name: "checkout",
          title: "Fix checkout",
          prompt: "fix it",
          provider: "codex",
          status: "ready",
          run_checks: true,
          open_pr: false,
          draft_pr: false,
          detail: "Ready for review",
          created_at: "1",
          updated_at: "2",
        },
      }),
    ).toEqual({
      id: "background-task-4-ready",
      title: "checkout \u00b7 Fix checkout",
      body: "Task ready: Ready for review",
    });
  });

  it("stays silent for non-terminal background task updates", () => {
    expect(
      notificationForArchcarEvent({
        type: "background_task_updated",
        task: {
          id: 4,
          repository_name: "repo",
          title: "Fix checkout",
          prompt: "fix it",
          provider: "codex",
          status: "running",
          run_checks: true,
          open_pr: false,
          draft_pr: false,
          detail: "Running",
          created_at: "1",
          updated_at: "2",
        },
      }),
    ).toBeNull();
  });
});
