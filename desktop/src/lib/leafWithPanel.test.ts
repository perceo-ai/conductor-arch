// @vitest-environment node
import { describe, expect, it } from "vitest";
import { leaf, leafWithPanel, split } from "./layout";

describe("leafWithPanel", () => {
  it("finds the leaf whose tab set includes the panel, however deep", () => {
    const chat = leaf(["chat", "checks"], { collapsed: true });
    const root = split("column", leaf(["pr"]), split("row", chat, leaf(["summary", "files"]), 0.6), 0.12);
    expect(leafWithPanel(root, "chat")).toBe(chat);
    expect(leafWithPanel(root, "summary")?.panels).toEqual(["summary", "files"]);
  });

  it("returns the first match in tree order, and nothing for an absent panel", () => {
    const first = leaf(["chat"]);
    const root = split("row", first, leaf(["chat"]), 0.5);
    expect(leafWithPanel(root, "chat")).toBe(first);
    expect(leafWithPanel(root, "terminal")).toBeUndefined();
  });
});
