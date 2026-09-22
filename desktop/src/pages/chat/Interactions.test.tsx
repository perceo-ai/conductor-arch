// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "solid-js/web";
import type { InteractionQuestion, ProviderInteractionRecord } from "@/bridge/protocol";

const resolveInteraction = vi.fn(() => Promise.resolve());
vi.mock("@/store", () => ({ actions: { resolveInteraction } }));
vi.mock("@/store/actions", () => ({ actions: { resolveInteraction } }));

const { InteractionBanner } = await import("./Interactions");

function question(id: string, overrides: Partial<InteractionQuestion> = {}): InteractionQuestion {
  return {
    id,
    header: id,
    question: `Question ${id}?`,
    options: [
      { label: "Alpha", description: "first" },
      { label: "Beta", description: "second" },
    ],
    allow_other: true,
    multi_select: false,
    ...overrides,
  };
}

function record(questions: InteractionQuestion[]): ProviderInteractionRecord {
  return {
    id: "int-1",
    provider_key: "claude",
    workspace: "smoke",
    thread_id: 1,
    session_id: 1,
    kind: "user_question",
    title: "Agent asked",
    detail: "",
    questions,
    status: "pending",
  };
}

let dispose: (() => void) | undefined;
let host: HTMLDivElement | undefined;

function mount(rec: ProviderInteractionRecord) {
  host = document.createElement("div");
  document.body.appendChild(host);
  dispose = render(() => <InteractionBanner rec={rec} />, host);
  return host;
}

const options = (el: HTMLElement) =>
  Array.from(el.querySelectorAll<HTMLButtonElement>(".chat-interaction-option"));
const advance = (el: HTMLElement) =>
  el.querySelector<HTMLButtonElement>(".chat-interaction-advance")!;

afterEach(() => {
  dispose?.();
  host?.remove();
  dispose = undefined;
  host = undefined;
  resolveInteraction.mockClear();
});

describe("InteractionBanner questions", () => {
  it("shows one question at a time with numbered options", () => {
    const el = mount(record([question("a"), question("b")]));
    expect(el.querySelectorAll(".chat-interaction-question-text")).toHaveLength(1);
    expect(el.querySelector(".chat-interaction-question-text")?.textContent).toBe("Question a?");
    expect(options(el).map((it) => it.querySelector(".chat-interaction-option-index")?.textContent))
      .toEqual(["1)", "2)"]);
    expect(el.querySelector(".chat-interaction-question-count")?.textContent).toBe("1/2");
  });

  // Picking an option used to resolve the whole interaction at once, so a
  // second question never got asked.
  it("collects every question's answer before resolving", () => {
    const el = mount(record([question("a"), question("b")]));
    options(el)[0].click();
    expect(advance(el).textContent).toBe("Next");
    advance(el).click();
    expect(resolveInteraction).not.toHaveBeenCalled();
    expect(el.querySelector(".chat-interaction-question-text")?.textContent).toBe("Question b?");
    options(el)[1].click();
    expect(advance(el).textContent).toBe("Submit");
    advance(el).click();
    expect(resolveInteraction).toHaveBeenCalledWith("int-1", {
      type: "answer",
      answers: [
        { question_id: "a", values: ["Alpha"] },
        { question_id: "b", values: ["Beta"] },
      ],
    });
  });

  // Submit answers the whole ask, never a slice of it: it stays disabled while
  // any question is blank, and Enter from the free-text row walks the user back
  // to the first gap instead of resolving without it.
  it("refuses to submit while an earlier question is unanswered", () => {
    const el = mount(record([question("a"), question("b")]));
    el.querySelector<HTMLButtonElement>('[aria-label="Next question"]')!.click();
    options(el)[1].click();
    expect(advance(el).textContent).toBe("Submit");
    expect(advance(el).disabled).toBe(true);
    const input = el.querySelector<HTMLInputElement>(".chat-interaction-other-input")!;
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(resolveInteraction).not.toHaveBeenCalled();
    expect(el.querySelector(".chat-interaction-question-text")?.textContent).toBe("Question a?");
    options(el)[0].click();
    advance(el).click();
    advance(el).click();
    expect(resolveInteraction).toHaveBeenCalledWith("int-1", {
      type: "answer",
      answers: [
        { question_id: "a", values: ["Alpha"] },
        { question_id: "b", values: ["Beta"] },
      ],
    });
  });

  it("pages back to an earlier question and keeps its pick", () => {
    const el = mount(record([question("a"), question("b")]));
    options(el)[0].click();
    advance(el).click();
    el.querySelector<HTMLButtonElement>('[aria-label="Previous question"]')!.click();
    expect(el.querySelector(".chat-interaction-question-text")?.textContent).toBe("Question a?");
    expect(options(el)[0].getAttribute("aria-pressed")).toBe("true");
  });

  it("sends typed free text alongside the pick", () => {
    const el = mount(record([question("a")]));
    const input = el.querySelector<HTMLInputElement>(".chat-interaction-other-input")!;
    input.value = "something else";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    advance(el).click();
    expect(resolveInteraction).toHaveBeenCalledWith("int-1", {
      type: "answer",
      answers: [{ question_id: "a", values: ["something else"] }],
    });
  });

  it("hides the free-text row when the provider disallows it", () => {
    const el = mount(record([question("a", { allow_other: false })]));
    expect(el.querySelector(".chat-interaction-other-input")).toBeNull();
    expect(advance(el).disabled).toBe(true);
  });

  // Numbers on the rows are the shortcut; arrows page. Both are dead keys
  // while the free-text input has focus, where they are text.
  it("picks by digit and pages by arrow key", () => {
    const el = mount(record([question("a"), question("b")]));
    const wizard = el.querySelector(".chat-interaction-question")!;
    wizard.dispatchEvent(new KeyboardEvent("keydown", { key: "2", bubbles: true }));
    expect(options(el)[1].getAttribute("aria-pressed")).toBe("true");
    wizard.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    expect(el.querySelector(".chat-interaction-question-text")?.textContent).toBe("Question b?");
    const input = el.querySelector<HTMLInputElement>(".chat-interaction-other-input")!;
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }));
    expect(el.querySelector(".chat-interaction-question-text")?.textContent).toBe("Question b?");
  });

  it("keeps multiple picks for a multi-select question", () => {
    const el = mount(record([question("a", { multi_select: true })]));
    options(el)[0].click();
    options(el)[1].click();
    advance(el).click();
    expect(resolveInteraction).toHaveBeenCalledWith("int-1", {
      type: "answer",
      answers: [{ question_id: "a", values: ["Alpha", "Beta"] }],
    });
  });
});
