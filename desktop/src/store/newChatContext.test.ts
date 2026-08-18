import { describe, expect, it } from "vitest";
import { newChatContextStore } from "./newChatContext";
import type { NewChatContextPick } from "@/lib/newChatContext";

function pick(key: string): NewChatContextPick {
  return { key, kind: "plan", label: key, body: `body of ${key}` };
}

describe("newChatContextStore", () => {
  it("keeps picks per thread", () => {
    newChatContextStore.toggle(1, pick("plan:a"));
    newChatContextStore.toggle(2, pick("plan:b"));

    expect(newChatContextStore.picks(1).map((p) => p.key)).toEqual(["plan:a"]);
    expect(newChatContextStore.picks(2).map((p) => p.key)).toEqual(["plan:b"]);
    expect(newChatContextStore.selected(1, "plan:b")).toBe(false);
  });

  it("toggles a pick off and removes by key", () => {
    newChatContextStore.set(3, [pick("plan:a"), pick("plan:b")]);
    newChatContextStore.toggle(3, pick("plan:a"));
    expect(newChatContextStore.picks(3).map((p) => p.key)).toEqual(["plan:b"]);

    newChatContextStore.remove(3, "plan:b");
    expect(newChatContextStore.picks(3)).toEqual([]);
  });

  it("clears a thread's picks after a send", () => {
    newChatContextStore.set(4, [pick("plan:a")]);
    newChatContextStore.clear(4);
    expect(newChatContextStore.picks(4)).toEqual([]);
  });

  it("reports no picks for an untouched thread", () => {
    expect(newChatContextStore.picks(99)).toEqual([]);
  });
});
