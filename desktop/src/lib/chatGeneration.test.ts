import { describe, expect, it } from "vitest";
import {
  chatGenerationState,
  generationLabel,
  showsGenerationLoader,
  type ChatGenerationInput,
} from "./chatGeneration";

function input(over: Partial<ChatGenerationInput> = {}): ChatGenerationInput {
  return {
    session: null,
    phase: { kind: "ready" },
    blockedOnUser: false,
    ...over,
  };
}

const RUNNING = { runtime_state: "running", ready: false };
const BOOTING = { runtime_state: "idle", ready: false };
const READY = { runtime_state: "idle", ready: true };

describe("chatGenerationState", () => {
  it("is idle with no session and nothing pending", () => {
    expect(chatGenerationState(input())).toBe("idle");
  });

  it("is generating while the session is running a turn", () => {
    expect(chatGenerationState(input({ session: RUNNING }))).toBe("generating");
  });

  it("is idle once the session reports ready", () => {
    expect(chatGenerationState(input({ session: READY }))).toBe("idle");
  });

  it("is starting for a session that exists but has not come up", () => {
    expect(chatGenerationState(input({ session: BOOTING }))).toBe("starting");
  });

  it("is starting while a session is being created or launched", () => {
    expect(chatGenerationState(input({ phase: { kind: "starting" } }))).toBe("starting");
    expect(chatGenerationState(input({ phase: { kind: "creating" } }))).toBe("starting");
  });

  it("is idle for non-launch phases with no session", () => {
    expect(chatGenerationState(input({ phase: { kind: "draining" } }))).toBe("idle");
    expect(chatGenerationState(input({ phase: { kind: "failed" } }))).toBe("idle");
  });

  it("reports idle when the agent is blocked on the user, despite a busy session", () => {
    // The whole point of the flag: `ready` is false here, but no output is
    // coming until the user answers, so no loader.
    expect(chatGenerationState(input({ session: RUNNING, blockedOnUser: true }))).toBe("idle");
    expect(chatGenerationState(input({ session: BOOTING, blockedOnUser: true }))).toBe("idle");
    expect(chatGenerationState(input({ phase: { kind: "starting" }, blockedOnUser: true }))).toBe("idle");
  });
});

describe("showsGenerationLoader", () => {
  it("shows for both busy states and hides when idle", () => {
    expect(showsGenerationLoader("generating")).toBe(true);
    expect(showsGenerationLoader("starting")).toBe(true);
    expect(showsGenerationLoader("idle")).toBe(false);
  });
});

describe("generationLabel", () => {
  it("names each state, escalating the wording for a slow start", () => {
    expect(generationLabel("generating")).toBe("Generating");
    expect(generationLabel("starting")).toBe("Starting");
    expect(generationLabel("starting", true)).toBe("Still starting");
    expect(generationLabel("idle")).toBe("");
  });

  it("does not let a slow start change the generating wording", () => {
    expect(generationLabel("generating", true)).toBe("Generating");
  });
});
