// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { render } from "solid-js/web";

import ClientSwitcher from "./ClientSwitcher";

let dispose: (() => void) | undefined;

afterEach(() => {
  dispose?.();
  dispose = undefined;
  document.body.innerHTML = "";
});

describe("ClientSwitcher", () => {
  it("keeps connection detail out of the compact row and in its read-only Peek", async () => {
    window.archductor = {
      clientsList: async () => ({ ok: true, activeId: null, clients: [] }),
    } as unknown as typeof window.archductor;
    const host = document.createElement("div");
    document.body.append(host);
    dispose = render(() => <ClientSwitcher />, host);
    await Promise.resolve();

    const trigger = host.querySelector<HTMLButtonElement>(".client-switcher-button")!;
    expect(trigger.textContent).toContain("This machine");
    expect(trigger.querySelector(".client-switcher-address")).toBeNull();

    trigger.focus();
    const tooltip = document.querySelector<HTMLElement>("[role='tooltip']");
    expect(tooltip?.textContent).toContain("local daemon");
    expect(tooltip?.textContent).toContain("This device");
    expect(tooltip?.querySelector("button")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });
});
