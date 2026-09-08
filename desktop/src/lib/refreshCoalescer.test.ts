import { describe, expect, it } from "vitest";
import { createRefreshCoalescer } from "./refreshCoalescer";

/** Manual clock + scheduler so the tests assert behaviour, not wall time. */
function harness(intervalMs = 100) {
  let clock = 1_000;
  const timers: { at: number; fn: () => void }[] = [];
  const runs: number[] = [];
  const coalescer = createRefreshCoalescer<number>((key) => runs.push(key), {
    intervalMs,
    now: () => clock,
    schedule: (fn, delayMs) => void timers.push({ at: clock + delayMs, fn }),
  });
  function advance(ms: number) {
    clock += ms;
    const due = timers.filter((t) => t.at <= clock);
    for (const timer of due) timers.splice(timers.indexOf(timer), 1);
    for (const timer of due) timer.fn();
  }
  return { coalescer, runs, advance };
}

describe("createRefreshCoalescer", () => {
  it("runs an isolated request immediately", () => {
    const { coalescer, runs } = harness();
    coalescer.request(7);
    expect(runs).toEqual([7]);
  });

  it("collapses a burst of requests into one trailing run per interval", () => {
    const { coalescer, runs, advance } = harness(100);
    // A streamed turn: the first token pulls, the next 49 must not.
    for (let i = 0; i < 50; i += 1) coalescer.request(7);
    expect(runs).toEqual([7]);

    advance(100);
    expect(runs).toEqual([7, 7]);
  });

  it("keeps a burst bounded by the interval rather than by the event rate", () => {
    const { coalescer, runs, advance } = harness(100);
    // 500 events spread over 500ms — one per millisecond.
    for (let i = 0; i < 500; i += 1) {
      coalescer.request(7);
      advance(1);
    }
    // Six runs across 500ms, not 500.
    expect(runs.length).toBeLessThanOrEqual(6);
  });

  it("rate-limits each key independently", () => {
    const { coalescer, runs } = harness(100);
    coalescer.request(1);
    coalescer.request(2);
    expect(runs).toEqual([1, 2]);
  });

  it("runs a request again once the interval has passed", () => {
    const { coalescer, runs, advance } = harness(100);
    coalescer.request(7);
    advance(150);
    coalescer.request(7);
    expect(runs).toEqual([7, 7]);
  });

  it("flushes immediately even inside an interval", () => {
    const { coalescer, runs } = harness(100);
    coalescer.request(7);
    coalescer.flush(7);
    expect(runs).toEqual([7, 7]);
  });

  it("does not re-run a trailing pull that a flush already overtook", () => {
    const { coalescer, runs, advance } = harness(100);
    coalescer.request(7); // immediate
    coalescer.request(7); // schedules the trailing run
    expect(coalescer.pendingKeys()).toEqual([7]);

    coalescer.flush(7); // turn completed; final state pulled now
    expect(runs).toEqual([7, 7]);

    advance(100); // the trailing timer fires into a superseded generation
    expect(runs).toEqual([7, 7]);
  });
});
