// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "solid-js/web";
import type { ProviderInteractionRecord } from "@/bridge/protocol";

const resolveInteraction = vi.fn(() => Promise.resolve());
const revealPanel = vi.fn();
vi.mock("@/store", () => ({ actions: { resolveInteraction, revealPanel } }));
vi.mock("@/store/actions", () => ({ actions: { resolveInteraction, revealPanel } }));

const { PlanCard } = await import("./Interactions");

/**
 * A plan used to be pinned above the composer with its approve button living in
 * the composer's own chrome — one object split across two surfaces, in a place
 * the scrollback could not reach. It is a message now, and it carries the
 * actions that resolve it.
 */
const PLAN: ProviderInteractionRecord = {
  id: "int-1",
  provider_key: "codex",
  workspace: "smoke",
  thread_id: 1,
  session_id: 1,
  kind: "plan_approval",
  title: "Proposed plan",
  detail: "## Step one\n\nDo the thing.",
  questions: [],
  plan_path: ".context/plans/2026-08-26-thing.md",
  status: "pending",
};

let dispose: (() => void) | undefined;
let host: HTMLDivElement | undefined;

function mount(rec: ProviderInteractionRecord = PLAN) {
  host = document.createElement("div");
  document.body.appendChild(host);
  dispose = render(() => <PlanCard rec={rec} workspace="smoke" />, host);
  return host;
}

afterEach(() => {
  dispose?.();
  host?.remove();
  dispose = undefined;
  host = undefined;
  resolveInteraction.mockClear();
  revealPanel.mockClear();
});

describe("PlanCard", () => {
  it("renders the plan body as markdown", () => {
    const el = mount();
    expect(el.querySelector(".chat-plan-card-body h2")?.textContent).toBe("Step one");
  });

  it("shows the path the plan was written to", () => {
    const el = mount();
    expect(el.querySelector(".chat-plan-card-path")?.textContent).toBe(
      ".context/plans/2026-08-26-thing.md",
    );
  });

  it("approves from the card itself", () => {
    const el = mount();
    const approve = el.querySelector(".chat-plan-approve") as HTMLButtonElement;
    expect(approve).toBeTruthy();
    approve.click();
    expect(resolveInteraction).toHaveBeenCalledWith("int-1", { type: "approve" });
  });

  it("opens the plan file in the centre panel", () => {
    const el = mount();
    (el.querySelector(".chat-plan-card-open") as HTMLButtonElement).click();
    expect(revealPanel).toHaveBeenCalledWith("chat");
  });

  it("offers no open button when the plan was never written to a file", () => {
    const el = mount({ ...PLAN, plan_path: undefined });
    expect(el.querySelector(".chat-plan-card-open")).toBeNull();
    // Approving must still be possible — the plan is in the card either way.
    expect(el.querySelector(".chat-plan-approve")).toBeTruthy();
  });
});
