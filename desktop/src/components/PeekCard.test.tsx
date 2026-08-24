// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "solid-js/web";

import PeekCard, { computePeekPosition } from "./PeekCard";

let dispose: (() => void) | undefined;

function mount(delay = 300) {
  const host = document.createElement("div");
  document.body.append(host);
  dispose = render(
    () => (
      <PeekCard delay={delay} content={<div>Branch: feature/peek-actions</div>}>
        {(trigger) => <button {...trigger}>Workspace</button>}
      </PeekCard>
    ),
    host,
  );
  return host.querySelector("button")!;
}

afterEach(() => {
  dispose?.();
  dispose = undefined;
  document.body.innerHTML = "";
  vi.useRealTimers();
});

describe("PeekCard", () => {
  it("flips and clamps a preview that would leave the viewport", () => {
    expect(
      computePeekPosition(
        { left: 800, right: 900, top: 550 },
        { width: 240, height: 150 },
        { width: 1000, height: 600 },
      ),
    ).toEqual({ side: "left", left: 550, top: 440 });
  });

  it("opens only after the hover intent delay", () => {
    vi.useFakeTimers();
    const trigger = mount();

    trigger.dispatchEvent(new Event("pointerenter"));
    vi.advanceTimersByTime(299);
    expect(document.querySelector("[role='tooltip']")).toBeNull();

    vi.advanceTimersByTime(1);
    expect(document.querySelector("[role='tooltip']")?.textContent).toContain(
      "feature/peek-actions",
    );
  });

  it("opens immediately for keyboard focus without moving focus into the preview", () => {
    const trigger = mount();

    trigger.focus();

    const tooltip = document.querySelector<HTMLElement>("[role='tooltip']");
    expect(tooltip).not.toBeNull();
    expect(trigger.getAttribute("aria-describedby")).toBe(tooltip?.id);
    expect(document.activeElement).toBe(trigger);
  });

  it("closes on Escape and keeps focus on its trigger", () => {
    const trigger = mount();
    trigger.focus();
    expect(document.querySelector("[role='tooltip']")).not.toBeNull();

    trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));

    expect(document.querySelector("[role='tooltip']")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });
});
