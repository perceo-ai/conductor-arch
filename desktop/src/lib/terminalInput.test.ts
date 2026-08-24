// @vitest-environment node
import { describe, expect, it } from "vitest";
import { createTerminalInputQueue } from "./terminalInput";

/** A send whose completions can be resolved in an arbitrary order. */
function controllableSend() {
  const calls: Array<{ data: string; resolve: () => void; reject: (e: unknown) => void }> = [];
  const send = (data: string) =>
    new Promise<void>((resolve, reject) => {
      calls.push({ data, resolve, reject });
    });
  return { send, calls };
}

describe("createTerminalInputQueue", () => {
  it("keeps only one request in flight", async () => {
    const { send, calls } = controllableSend();
    const q = createTerminalInputQueue(send);

    q.write("a");
    q.write("b");
    q.write("c");
    await Promise.resolve();

    // Without serialisation this would already be three concurrent calls, and
    // their completion order — hence the order the daemon sees them — would be
    // whatever the transport happened to do.
    expect(calls).toHaveLength(1);
    expect(calls[0].data).toBe("a");
  });

  it("coalesces everything typed during a request into the next one", async () => {
    const { send, calls } = controllableSend();
    const q = createTerminalInputQueue(send);

    q.write("p");
    await Promise.resolve();
    q.write("r");
    q.write("i");
    q.write("n");
    calls[0].resolve();
    // Let the pump start the follow-up before resolving it, or drain() would
    // wait on a request the test never completes.
    await Promise.resolve();
    await Promise.resolve();
    calls[1].resolve();
    await q.drain();

    expect(calls.map((c) => c.data)).toEqual(["p", "rin"]);
  });

  it("delivers a burst in the order it was typed", async () => {
    const { send, calls } = controllableSend();
    const q = createTerminalInputQueue(send);

    for (const ch of "printf") {
      q.write(ch);
      // Let the queue turn over between keys, as real typing would.
      await Promise.resolve();
      if (calls.length) calls[calls.length - 1].resolve();
    }
    await q.drain();

    expect(calls.map((c) => c.data).join("")).toBe("printf");
  });

  it("preserves order even when every send resolves late", async () => {
    const { send, calls } = controllableSend();
    const q = createTerminalInputQueue(send);

    "abcdef".split("").forEach((ch) => q.write(ch));
    // Drain by resolving whatever is currently in flight, repeatedly.
    for (let i = 0; i < 10 && calls.length; i += 1) {
      const pending = calls[calls.length - 1];
      pending.resolve();
      await Promise.resolve();
      await Promise.resolve();
    }
    await q.drain();

    expect(calls.map((c) => c.data).join("")).toBe("abcdef");
  });

  it("ignores empty writes", async () => {
    const { send, calls } = controllableSend();
    const q = createTerminalInputQueue(send);
    q.write("");
    await Promise.resolve();
    expect(calls).toHaveLength(0);
  });

  it("does not wedge when a send rejects", async () => {
    const { send, calls } = controllableSend();
    const q = createTerminalInputQueue(send);

    q.write("x");
    await Promise.resolve();
    calls[0].reject(new Error("socket closed"));
    await Promise.resolve();
    await Promise.resolve();

    q.write("y");
    await Promise.resolve();
    // A failed keystroke must not stop later ones from being attempted.
    expect(calls.map((c) => c.data)).toEqual(["x", "y"]);
  });

  it("drops queued input after dispose", async () => {
    const { send, calls } = controllableSend();
    const q = createTerminalInputQueue(send);
    q.dispose();
    q.write("z");
    await Promise.resolve();
    expect(calls).toHaveLength(0);
  });
});
