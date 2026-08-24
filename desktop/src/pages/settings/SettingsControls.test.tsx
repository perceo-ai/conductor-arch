// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "solid-js/web";

import { SettingsRow } from "./SettingsControls";

let dispose: (() => void) | undefined;

afterEach(() => {
  dispose?.();
  dispose = undefined;
  document.body.innerHTML = "";
  vi.useRealTimers();
});

describe("SettingsRow", () => {
  it("offers its explanatory copy as a read-only keyboard-focus Peek", () => {
    const host = document.createElement("div");
    document.body.append(host);
    dispose = render(
      () => (
        <SettingsRow
          title="Branch naming"
          description="Controls how new workspace branches are named."
          meta="Inherited from repository settings"
          control={<button>Change</button>}
        />
      ),
      host,
    );

    const help = host.querySelector<HTMLElement>("[aria-label='About Branch naming']");
    expect(help).not.toBeNull();
    help?.focus();

    const tooltip = document.querySelector<HTMLElement>("[role='tooltip']");
    expect(tooltip?.textContent).toContain("Controls how new workspace branches are named.");
    expect(tooltip?.textContent).toContain("Inherited from repository settings");
    expect(document.activeElement).toBe(help);
    expect(tooltip?.querySelector("button")).toBeNull();
  });

  it("opens the contextual Peek when the settings row itself is hovered", () => {
    vi.useFakeTimers();
    const host = document.createElement("div");
    document.body.append(host);
    dispose = render(
      () => <SettingsRow title="Theme" description="Choose the desktop appearance." />,
      host,
    );

    host.querySelector<HTMLElement>(".settings-row")?.dispatchEvent(new Event("pointerenter"));
    vi.advanceTimersByTime(300);

    expect(document.querySelector("[role='tooltip']")?.textContent).toContain(
      "Choose the desktop appearance.",
    );
  });
});
