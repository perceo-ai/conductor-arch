import { describe, expect, it } from "vitest";
import {
  sidebarWorkspaceNames,
  sidebarWorkspaceOrder,
  type SidebarRowFields,
} from "./sidebarWorkspaces";

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

describe("sidebarWorkspaceOrder", () => {
  const repos = ["demo", "other"];

  it("counts down the rendered list, project group by project group", () => {
    expect(sidebarWorkspaceOrder(repos, order, (n) => rows[n], none)).toEqual([
      "berlin",
      "rome",
      "oslo",
    ]);
  });

  it("follows pins, so a pinned row's slot matches where it is drawn", () => {
    const pinned = (n: string) => n === "rome";
    expect(sidebarWorkspaceOrder(repos, order, (n) => rows[n], pinned)).toEqual([
      "rome",
      "berlin",
      "oslo",
    ]);
  });

  it("ignores the sidebar filter so slots hold still while someone types", () => {
    // sidebarWorkspaceOrder takes no filter at all: this is the contract that
    // mod+2 means the same row before and after a search.
    expect(sidebarWorkspaceOrder(repos, order, (n) => rows[n], none)[1]).toBe("rome");
  });

  it("still keeps a workspace whose repository has no group", () => {
    const extra: Record<string, SidebarRowFields> = {
      ...rows,
      lima: { repository: "gone", status: "active" },
    };
    expect(sidebarWorkspaceOrder(repos, [...order, "lima"], (n) => extra[n], none)).toEqual([
      "berlin",
      "rome",
      "oslo",
      "lima",
    ]);
  });

  it("drops archived workspaces and unknown rows", () => {
    expect(sidebarWorkspaceOrder(repos, [...order, "ghost"], (n) => rows[n], none)).not.toContain(
      "paris",
    );
    expect(sidebarWorkspaceOrder(repos, [...order, "ghost"], (n) => rows[n], none)).not.toContain(
      "ghost",
    );
  });
});
