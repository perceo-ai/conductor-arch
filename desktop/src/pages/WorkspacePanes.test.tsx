// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "solid-js/web";

// The workspace view itself is heavy and covered elsewhere; a stub that shows
// what its pane hands it is what these tests are about.
vi.mock("./CommandCenter", async () => {
  const { Show } = await import("solid-js");
  const { usePane } = await import("./paneContext");
  const { default: PaneChrome } = await import("./PaneChrome");
  return {
    default: (props: { workspace: string }) => {
      const pane = usePane();
      return (
        <div
          class="stub-center"
          data-workspace={props.workspace}
          data-thread={String(pane.threadId())}
          data-focused={String(pane.focused())}
          data-index={String(pane.index())}
        >
          {/* The real CommandCenter puts this at the end of its topbar
              actions, behind the controls only a focused pane shows — the
              order that keeps the close button still while a click on an
              unfocused pane focuses it. */}
          <div class="stub-topbar-actions">
            <Show when={pane.focused()}>
              <button class="stub-focused-only" />
            </Show>
            <PaneChrome workspace={props.workspace} />
          </div>
        </div>
      );
    },
  };
});

const { nav } = await import("@/store");
const { default: WorkspacePanes } = await import("./WorkspacePanes");
const { WORKSPACE_MIME, workspaceDragProps } = await import("@/lib/workspaceDrag");

let dispose: (() => void) | undefined;

afterEach(() => {
  dispose?.();
  dispose = undefined;
  nav.resetWorkspacePanes();
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

/** jsdom has no DataTransfer; the handlers only need setData/getData. */
function dataTransfer() {
  const store: Record<string, string> = {};
  return {
    effectAllowed: "",
    dropEffect: "",
    setData: (type: string, value: string) => {
      store[type] = value;
    },
    getData: (type: string) => store[type] ?? "",
  };
}

function fire(target: EventTarget, type: string, transfer: ReturnType<typeof dataTransfer>) {
  const event = new Event(type, { bubbles: true, cancelable: true }) as Event & { dataTransfer: unknown };
  event.dataTransfer = transfer;
  target.dispatchEvent(event);
  return event;
}

/**
 * Drag `name` (as the sidebar does, via the shared drag props) and drop it on
 * `zone` of pane `paneIndex`.
 */
function dragOnto(host: HTMLElement, name: string, paneIndex: number, zone: string) {
  const transfer = dataTransfer();
  workspaceDragProps(() => name).onDragStart(
    Object.assign(new Event("dragstart"), { dataTransfer: transfer }) as unknown as DragEvent,
  );
  expect(transfer.getData(WORKSPACE_MIME)).toBe(name);
  const pane = host.querySelectorAll<HTMLElement>(".ws-pane")[paneIndex];
  const target = pane.querySelector<HTMLElement>(`.ws-pane-dropzone-${zone}`);
  expect(target, `pane ${paneIndex} offers a ${zone} drop zone`).not.toBeNull();
  fire(target!, "dragover", transfer);
  fire(target!, "drop", transfer);
}

describe("WorkspacePanes", () => {
  it("shows the selected workspace with no tab strip", () => {
    nav.selectWorkspace("alpha");
    nav.selectWorkspace("beta");
    const host = mount();
    expect(host.querySelector(".ws-pane-tabbar")).toBeNull();
    // Selecting replaces what the pane holds rather than stacking tabs.
    expect(centers(host)).toEqual([{ workspace: "beta", thread: "null", focused: "true" }]);
    expect(host.querySelectorAll(".ws-pane")).toHaveLength(1);
  });

  it("splits when a workspace is dropped on a lone pane's edge", () => {
    nav.selectWorkspace("alpha");
    nav.selectChatThread(11);
    const host = mount();

    dragOnto(host, "beta", 0, "right");

    expect(host.querySelector(".ws-panes-split")).not.toBeNull();
    expect(centers(host)).toEqual([
      { workspace: "alpha", thread: "11", focused: "false" },
      { workspace: "beta", thread: "null", focused: "true" },
    ]);
  });

  it("drops on the middle of a pane to replace what it holds", () => {
    nav.selectWorkspace("alpha");
    const host = mount();
    dragOnto(host, "beta", 0, "right");

    // Onto the other (unfocused) pane: it takes gamma, the split stays.
    dragOnto(host, "gamma", 0, "here");
    expect(centers(host).map((center) => center.workspace)).toEqual(["gamma", "beta"]);
    expect(nav.selectedWorkspace()).toBe("gamma");
  });

  it("swaps the panes when one pane's workspace is dropped on the other", () => {
    nav.selectWorkspace("alpha");
    const host = mount();
    dragOnto(host, "beta", 0, "right");

    dragOnto(host, "beta", 0, "here");
    expect(centers(host).map((center) => center.workspace)).toEqual(["beta", "alpha"]);
    expect(host.querySelector(".ws-panes-split")).not.toBeNull();
  });

  it("offers no split zones once the view is split", () => {
    nav.selectWorkspace("alpha");
    const host = mount();
    dragOnto(host, "beta", 0, "right");

    const transfer = dataTransfer();
    workspaceDragProps(() => "gamma").onDragStart(
      Object.assign(new Event("dragstart"), { dataTransfer: transfer }) as unknown as DragEvent,
    );
    expect(host.querySelectorAll(".ws-pane-dropzone-right")).toHaveLength(0);
    expect(host.querySelectorAll(".ws-pane-dropzone-here")).toHaveLength(2);
  });

  it("focuses a pane on pointerdown inside it", () => {
    nav.selectWorkspace("alpha");
    const host = mount();
    nav.openWorkspaceInSplit("beta", "down");
    expect(host.querySelector(".ws-panes-down")).not.toBeNull();

    host.querySelectorAll<HTMLElement>(".stub-center")[0].dispatchEvent(new Event("pointerdown", { bubbles: true }));
    expect(nav.selectedWorkspace()).toBe("alpha");
    expect(centers(host).map((center) => center.focused)).toEqual(["true", "false"]);
  });

  it("closes an unfocused pane without the press moving its controls", () => {
    nav.selectWorkspace("alpha");
    const host = mount();
    nav.openWorkspaceInSplit("beta", "right");
    // Focus is on the new pane; press the close button on the other one. That
    // press must not focus the pane: focusing widens it and adds the
    // focused-pane controls, which would move the button before the release.
    const first = [...host.querySelectorAll<HTMLElement>(".ws-pane")][0];
    const close = first.querySelector<HTMLElement>(".ws-pane-close")!;
    close.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    expect(first.querySelector(".stub-focused-only")).toBeNull();
    expect(centers(host).map((center) => center.focused)).toEqual(["false", "true"]);
    close.click();

    expect(centers(host).map((center) => center.workspace)).toEqual(["beta"]);
    expect(host.querySelector(".ws-panes-split")).toBeNull();
  });

  it("unsplits from a pane's close button, which only exists when split", () => {
    nav.selectWorkspace("alpha");
    const host = mount();
    expect(host.querySelector(".ws-pane-close")).toBeNull();

    nav.openWorkspaceInSplit("beta", "right");
    const panes = [...host.querySelectorAll<HTMLElement>(".ws-pane")];
    expect(panes[1].querySelector<HTMLElement>(".stub-center")!.dataset.index).toBe("1");
    const close = panes[1].querySelector<HTMLElement>(".ws-pane-close");
    close!.click();

    expect(host.querySelector(".ws-panes-split")).toBeNull();
    expect(centers(host).map((center) => center.workspace)).toEqual(["alpha"]);
    expect(nav.selectedWorkspace()).toBe("alpha");
  });
});
