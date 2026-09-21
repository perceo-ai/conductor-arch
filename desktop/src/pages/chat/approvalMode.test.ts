// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import type { ArchcarRequest, ArchcarResponse } from "@/bridge/protocol";
import { applyApprovalMode, approvalModeRequest, supportsApprovalMode } from "./approvalMode";

const ack: ArchcarResponse = { type: "ack" };

function recorder(response: ArchcarResponse = ack) {
  const sent: ArchcarRequest[] = [];
  return {
    sent,
    send: (request: ArchcarRequest) => {
      sent.push(request);
      return Promise.resolve(response);
    },
  };
}

describe("approvalModeRequest", () => {
  it("is thread-scoped so it reaches a thread with no session", () => {
    expect(approvalModeRequest(7, true)).toEqual({
      type: "set_chat_approval_mode",
      thread_id: 7,
      mode: "default",
    });
    expect(approvalModeRequest(7, false)).toEqual({
      type: "set_chat_approval_mode",
      thread_id: 7,
      mode: "bypassPermissions",
    });
  });
});

describe("supportsApprovalMode", () => {
  it("offers the toggle on claude only", () => {
    expect(supportsApprovalMode("claude")).toBe(true);
    expect(supportsApprovalMode("codex")).toBe(false);
    expect(supportsApprovalMode("shell")).toBe(false);
    expect(supportsApprovalMode("")).toBe(false);
  });
});

describe("applyApprovalMode", () => {
  it("persists with no live session instead of only flipping local state", async () => {
    // The regression: turning supervision on before the first prompt used to
    // return early, so the launch read a NULL column and ran unsupervised.
    const { sent, send } = recorder();
    const setApprovalMode = vi.fn();
    const onError = vi.fn();

    await applyApprovalMode({ threadId: 3, ask: true, send, setApprovalMode, onError });

    expect(sent).toEqual([{ type: "set_chat_approval_mode", thread_id: 3, mode: "default" }]);
    expect(setApprovalMode).toHaveBeenCalledWith(3, true);
    expect(setApprovalMode).toHaveBeenCalledTimes(1);
    expect(onError).not.toHaveBeenCalled();
  });

  it("rolls the toggle back and reports when the daemon refuses", async () => {
    const { send } = recorder({ type: "error", message: "no such thread" });
    const setApprovalMode = vi.fn();
    const onError = vi.fn();

    await applyApprovalMode({ threadId: 3, ask: true, send, setApprovalMode, onError });

    expect(setApprovalMode.mock.calls).toEqual([
      [3, true],
      [3, false],
    ]);
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it("rolls back when the request throws", async () => {
    const setApprovalMode = vi.fn();
    const onError = vi.fn();

    await applyApprovalMode({
      threadId: 9,
      ask: false,
      send: () => Promise.reject(new Error("socket closed")),
      setApprovalMode,
      onError,
    });

    expect(setApprovalMode.mock.calls).toEqual([
      [9, false],
      [9, true],
    ]);
    expect(onError).toHaveBeenCalledTimes(1);
  });
});
