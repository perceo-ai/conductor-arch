// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "solid-js/web";
import type { ContextMenuItem } from "@/components/ContextMenu";

// The workspace view itself is heavy and covered elsewhere; a stub that shows
// what its pane hands it is what these tests are about.
vi.mock("./CommandCenter", async () => {
  const { usePane } = await import("./paneContext");
  return {
    default: (props: { workspace: string }) => {
      const pane = usePane();
      return (
        <div
          class="stub-center"
          data-workspace={props.workspace}
          data-thread={String(pane.threadId())}
          data-focused={String(pane.focused())}
        />
      );
    },
  };
});

const menus: ContextMenuItem[][] = [];
vi.mock("@/components/ContextMenu", () => ({
  openContextMenuAt: (_x: number, _y: number, items: ContextMenuItem[]) => menus.push(items),
}));

const { nav } = await import("@/store");
const { default: WorkspacePanes } = await import("./WorkspacePanes");

let dispose: (() => void) | undefined;

afterEach(() => {
  dispose?.();
  dispose = undefined;
  menus.length = 0;
  nav.resetWorkspaceTabs();
});

function mount() {
  const host = document.createElement("div");
  document.body.append(host);
  dispose = render(() => <WorkspacePanes />, host);
  return host;
}

function centers(host: HTMLElement) {
  return [...host.querySelectorAll<HTMLElement>(".stub-center")].map((el) => ({
    workspace: el.dataset.workspace,
    thread: el.dataset.thread,
    focused: el.dataset.focused,
  }));
}

function tabLabels(host: HTMLElement) {
  return [...host.querySelectorAll<HTMLElement>(".ws-pane")].map((pane) =>
    [...pane.querySelectorAll<HTMLElement>("[data-workspace-tab]")].map((tab) => tab.dataset.workspaceTab),
  );
}

describe("WorkspacePanes", () => {
  it("shows one tab per open workspace and the active one's view", () => {
    nav.selectWorkspace("alpha");
    nav.selectWorkspace("beta");
    const host = mount();
    expect(tabLabels(host)).toEqual([["alpha", "beta"]]);
    expect(centers(host)).toEqual([{ workspace: "beta", thread: "null", focused: "true" }]);

    host.querySelector<HTMLElement>("[data-workspace-tab='alpha']")!.click();
    expect(centers(host)[0].workspace).toBe("alpha");
    expect(nav.selectedWorkspace()).toBe("alpha");
  });

  it("splits from the tab menu and gives each pane its own chat", () => {
    nav.selectWorkspace("alpha");
    nav.selectChatThread(11);
    nav.selectWorkspace("beta");
    nav.selectChatThread(22);
    const host = mount();

    host
      .querySelector<HTMLElement>("[data-workspace-tab='beta']")!
      .dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 1, clientY: 1 }));
    const split = menus.at(-1)!.find((item) => item.label === "Split Right");
    expect(split).toBeDefined();
    split!.run();

    expect(tabLabels(host)).toEqual([["alpha"], ["beta"]]);
    expect(centers(host)).toEqual([
      { workspace: "alpha", thread: "11", focused: "false" },
      { workspace: "beta", thread: "22", focused: "true" },
    ]);
  });

  it("focuses a pane on pointerdown inside it", () => {
    nav.selectWorkspace("alpha");
    nav.selectWorkspace("beta");
    nav.splitWorkspaceTab("beta", "down");
    const host = mount();
    expect(host.querySelector(".ws-panes-down")).not.toBeNull();

    host.querySelectorAll<HTMLElement>(".stub-center")[0].dispatchEvent(new Event("pointerdown", { bubbles: true }));
    expect(nav.selectedWorkspace()).toBe("alpha");
    expect(centers(host).map((center) => center.focused)).toEqual(["true", "false"]);
  });

  it("closes a tab from its close button and collapses an emptied split", () => {
    nav.selectWorkspace("alpha");
    nav.selectWorkspace("beta");
    nav.splitWorkspaceTab("beta", "right");
    const host = mount();

    host.querySelector<HTMLElement>("[data-workspace-tab='beta'] .ws-pane-tab-close")!.click();
    expect(tabLabels(host)).toEqual([["alpha"]]);
    expect(host.querySelector(".ws-panes-split")).toBeNull();
    expect(nav.selectedWorkspace()).toBe("alpha");
  });
});
