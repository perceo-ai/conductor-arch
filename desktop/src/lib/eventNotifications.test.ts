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
  it("notifies when an agent needs input", () => {
    expect(notificationForArchcarEvent(interactionEvent)).toEqual({
      id: "interaction-ask-1",
      title: "Input required",
      body: "Approve command? - cargo test",
    });
  });

  it("notifies when a chat turn finishes", () => {
    expect(
      notificationForArchcarEvent({
        type: "turn_completed",
        session_id: 11,
        thread_id: 9,
        status: "completed",
      }),
    ).toEqual({
      id: "turn-11-9-completed",
      title: "Chat finished",
      body: "Thread 9 completed.",
    });
  });

  it("notifies when a session errors", () => {
    expect(
      notificationForArchcarEvent({
        type: "session_error",
        session_id: 11,
        thread_id: 9,
        message: "codex exited before it was ready",
      }),
    ).toEqual({
      id: "session-error-11-9",
      title: "Chat failed",
      body: "codex exited before it was ready",
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
      title: "Background task ready",
      body: "#4 Fix checkout (checkout): Ready for review",
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
