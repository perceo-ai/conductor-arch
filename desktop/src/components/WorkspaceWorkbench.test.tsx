// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { render } from "solid-js/web";
import { leaf, split } from "@/lib/layout";
import { registerPanel, unregisterPanel } from "@/lib/panelRegistry";
import { layoutStore } from "@/store/layout";
import WorkspaceWorkbench from "./WorkspaceWorkbench";

// The thing the split shipped: an unfocused pane renders the chat leaf alone,
// so the inspector half of the tree exists only in the focused pane. Driven
// through the real workbench + layout store with stub panels standing in for
// the lazy-loaded real ones.

const CHAT_ID = "workbench-test-chat";
const SIDE_ID = "workbench-test-side";
let dispose: (() => void) | undefined;

beforeEach(() => {
  for (const [id, label] of [
    [CHAT_ID, "Chat body"],
    [SIDE_ID, "Side body"],
  ] as const) {
    registerPanel({
      id,
      title: label,
      icon: "file-text",
      kind: "tab",
      component: () => <div data-test-panel={id}>{label}</div>,
      requiresWorkspace: true,
    });
  }
  layoutStore.applyLayout({
    id: "workbench-test",
    name: "Workbench test",
    builtin: false,
    hidden: [],
    layout: {
      version: 2,
      root: split(
        "row",
        // "chat" must be the real panel id for compactChatRoot to find it; the
        // registered stub renders under it.
        leaf(["chat", CHAT_ID], { active: 1 }),
        leaf([SIDE_ID]),
        0.7,
      ),
    },
  } as never);
});

afterEach(() => {
  dispose?.();
  dispose = undefined;
  document.body.innerHTML = "";
  unregisterPanel(CHAT_ID);
  unregisterPanel(SIDE_ID);
  layoutStore.resetToCode();
});

function mount(compact: boolean) {
  const host = document.createElement("div");
  document.body.append(host);
  dispose = render(
    () => <WorkspaceWorkbench workspace="demo" compact={compact} topbar={<div data-test-topbar />} />,
    host,
  );
  return host;
}

describe("WorkspaceWorkbench compact", () => {
  it("renders the full tree, side leaf included, when not compact", () => {
    const host = mount(false);
    expect(host.querySelector(`[data-test-panel='${CHAT_ID}']`)).not.toBeNull();
    expect(host.querySelector(`[data-test-panel='${SIDE_ID}']`)).not.toBeNull();
    expect(host.querySelector(".workbench-split")).not.toBeNull();
  });

  it("renders only the chat leaf when compact", () => {
    const host = mount(true);
    expect(host.querySelector(`[data-test-panel='${CHAT_ID}']`)).not.toBeNull();
    expect(host.querySelector(`[data-test-panel='${SIDE_ID}']`)).toBeNull();
    expect(host.querySelector(".workbench-split")).toBeNull();
  });
});
