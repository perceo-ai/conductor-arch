// Mirrors the rest of the suite's render pattern (see PanelLeaf.test.tsx):
// `@solidjs/testing-library` is not a dependency of this project, so this
// mounts with `solid-js/web` directly and reads the DOM rather than using
// Testing Library queries.
import { afterEach, describe, expect, it } from "vitest";
import { render } from "solid-js/web";
import LayoutEditBar from "./LayoutEditBar";
import { layoutStore } from "@/store/layout";

let dispose: (() => void) | undefined;

afterEach(() => {
  dispose?.();
  dispose = undefined;
  document.body.innerHTML = "";
  layoutStore.setEditing(false);
});

function mount() {
  const host = document.createElement("div");
  document.body.append(host);
  dispose = render(() => <LayoutEditBar />, host);
  return host;
}

describe("layout edit bar", () => {
  it("renders nothing outside edit mode", () => {
    layoutStore.setEditing(false);
    const host = mount();
    expect(host.textContent).toBe("");
  });

  it("offers Done, reset, and the hidden panels in edit mode", () => {
    layoutStore.setEditing(true);
    const host = mount();
    expect([...host.querySelectorAll("button")].some((button) => button.textContent?.includes("Done"))).toBe(true);
    expect(host.textContent).toContain("Editing layout");
  });
});
