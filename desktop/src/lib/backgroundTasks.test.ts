// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { BackgroundTask } from "@/bridge/protocol";
import {
  BACKGROUND_TASK_STAGES,
  backgroundTaskIsActive,
  backgroundTaskProgress,
  backgroundTaskStageLabel,
  backgroundTaskSummary,
  backgroundTaskTone,
} from "./backgroundTasks";

function task(overrides: Partial<BackgroundTask>): BackgroundTask {
  return {
    id: 1,
    repository_name: "demo",
    workspace_name: "berlin",
    task_id: 4,
    title: "Add the Context tab",
    prompt: "Add the Context tab",
    provider: "codex",
    status: "running",
    run_checks: true,
    open_pr: false,
    draft_pr: true,
    detail: "",
    created_at: "1",
    updated_at: "1",
    ...overrides,
  };
}

describe("background task presentation", () => {
  it("labels every stage and terminal status", () => {
    expect(backgroundTaskStageLabel("pending")).toBe("Starting agent");
    expect(backgroundTaskStageLabel("checking")).toBe("Running checks");
    expect(backgroundTaskStageLabel("opening_pr")).toBe("Opening pull request");
    expect(backgroundTaskStageLabel("ready")).toBe("Ready for review");
    expect(backgroundTaskStageLabel("failed")).toBe("Failed");
  });

  it("separates in-flight tasks from finished ones", () => {
    for (const status of BACKGROUND_TASK_STAGES) {
      expect(backgroundTaskIsActive(status)).toBe(true);
    }
    expect(backgroundTaskIsActive("ready")).toBe(false);
    expect(backgroundTaskIsActive("failed")).toBe(false);
    expect(backgroundTaskIsActive("cancelled")).toBe(false);
    expect(backgroundTaskTone("pending")).toBe("waiting");
    expect(backgroundTaskTone("summarizing")).toBe("active");
  });

  it("advances progress monotonically through the working stages", () => {
    const values = BACKGROUND_TASK_STAGES.map(backgroundTaskProgress);
    for (let i = 1; i < values.length; i += 1) {
      expect(values[i]).toBeGreaterThan(values[i - 1]);
    }
    expect(values.at(-1)).toBeLessThan(1);
    expect(backgroundTaskProgress("ready")).toBe(1);
  });

  it("prefers the error over the progress detail in the row summary", () => {
    expect(backgroundTaskSummary(task({ status: "checking", detail: "Running checks: test" }))).toBe(
      "Running checks — Running checks: test",
    );
    expect(
      backgroundTaskSummary(
        task({ status: "failed", detail: "Preparing pull request", error: "no remote configured" }),
      ),
    ).toBe("Failed — no remote configured");
    expect(backgroundTaskSummary(task({ status: "running", detail: "" }))).toBe("Agent working");
  });
});
