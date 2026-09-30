import { describe, expect, it } from "vitest";
import { sidebarWorkspaceNames, type SidebarRowFields } from "./sidebarWorkspaces";

const rows: Record<string, SidebarRowFields> = {
  berlin: { repository: "demo", status: "active" },
  paris: { repository: "demo", status: "archived" },
  rome: { repository: "demo", status: "active" },
  oslo: { repository: "other", status: "active" },
};
const order = ["berlin", "paris", "rome", "oslo"];
const all = () => true;
const none = () => false;

describe("sidebarWorkspaceNames", () => {
  it("hides archived workspaces from the sidebar", () => {
    expect(sidebarWorkspaceNames(order, (n) => rows[n], "demo", all, none)).toEqual([
      "berlin",
      "rome",
    ]);
  });

  it("shows a workspace again once it is restored", () => {
    const restored: Record<string, SidebarRowFields> = {
      ...rows,
      paris: { repository: "demo", status: "active" },
    };
    expect(sidebarWorkspaceNames(order, (n) => restored[n], "demo", all, none)).toEqual([
      "berlin",
      "paris",
      "rome",
    ]);
  });

  it("keeps an archived workspace hidden even when pinned or matching the filter", () => {
    const pinned = (n: string) => n === "paris" || n === "rome";
    expect(sidebarWorkspaceNames(order, (n) => rows[n], "demo", all, pinned)).toEqual([
      "rome",
      "berlin",
    ]);
  });

  it("applies the filter and skips unknown rows", () => {
    const matches = (n: string) => n.startsWith("r");
    expect(
      sidebarWorkspaceNames([...order, "ghost"], (n) => rows[n], "demo", matches, none),
    ).toEqual(["rome"]);
  });
});
