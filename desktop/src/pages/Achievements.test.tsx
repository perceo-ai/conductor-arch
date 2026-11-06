// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "solid-js/web";

function entry(overrides: Record<string, unknown> = {}) {
  return {
    id: "worktree_wrangler",
    name: "Worktree Wrangler",
    description: "Spin up isolated workspaces.",
    category: "Workspaces",
    counts: "Workspaces created.",
    metric: "workspaces_created",
    kind: "lifetime",
    value: 7,
    tier: 1,
    tier_name: "Copper",
    next_threshold: 25,
    tier_thresholds: [5, 25, 100, 400, 1500],
    secret: false,
    ...overrides,
  };
}

const SUMMARY = {
  achievements: [
    entry(),
    entry({
      id: "merge_merchant",
      name: "Merge Merchant",
      category: "Shipping",
      value: 0,
      tier: null,
      tier_name: null,
      next_threshold: 1,
    }),
    // Secret and untouched: must stay hidden.
    entry({
      id: "red_text_connoisseur",
      name: "Red Text Connoisseur",
      category: "Debugging Chaos",
      value: 0,
      tier: null,
      tier_name: null,
      next_threshold: 10,
      secret: true,
    }),
  ],
  discovery: {
    total: 3,
    discovered: 1,
    names: [
      { name: "pipewire", discovered: true },
      { name: "gentoo", discovered: false },
      { name: "nixos", discovered: false },
    ],
  },
  metrics: { workspaces_created: 7 },
  unlocked: 1,
  tiers_earned: 1,
  total: 3,
};

const send = vi.fn(async (request: { type: string }) => {
  if (request.type === "get_achievements") return { type: "achievements", summary: SUMMARY };
  throw new Error(`Unexpected request: ${request.type}`);
});
vi.mock("@/bridge/client", () => ({ send }));

const { AchievementsPage } = await import("./Achievements");

let dispose: (() => void) | undefined;

function mount() {
  const host = document.createElement("div");
  document.body.append(host);
  dispose = render(() => <AchievementsPage />, host);
  return host;
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

afterEach(() => {
  dispose?.();
  dispose = undefined;
  document.body.innerHTML = "";
});

describe("AchievementsPage", () => {
  it("shows the scoreboard and the earned tier", async () => {
    const host = mount();
    await settle();

    expect(host.textContent).toContain("1/3");
    expect(host.textContent).toContain("unlocked");
    expect(host.textContent).toContain("Worktree Wrangler");
    expect(
      host.querySelector("[data-achievement='worktree_wrangler']")?.getAttribute("data-tier"),
    ).toBe("copper");
  });

  it("hides a secret achievement that has not been triggered", async () => {
    const host = mount();
    await settle();

    expect(host.textContent).not.toContain("Red Text Connoisseur");
    expect(host.textContent).toContain("1 secret achievement still hidden");
  });

  it("hides locked achievements when the toggle is cleared", async () => {
    const host = mount();
    await settle();
    expect(host.textContent).toContain("Merge Merchant");

    const toggle = host.querySelector<HTMLInputElement>(".ach-toggle input")!;
    toggle.checked = false;
    toggle.dispatchEvent(new Event("change", { bubbles: true }));
    await settle();

    expect(host.textContent).not.toContain("Merge Merchant");
    expect(host.textContent).toContain("Worktree Wrangler");
  });

  it("masks undiscovered names on the discovery tab", async () => {
    const host = mount();
    await settle();

    const tabs = [...host.querySelectorAll<HTMLButtonElement>(".ws-tab-shell")];
    tabs.find((button) => button.textContent === "Discovery")!.click();
    await settle();

    const names = [...host.querySelectorAll(".ach-name")].map((node) => node.textContent);
    expect(names[0]).toBe("pipewire");
    expect(names[1]).not.toContain("gentoo");
    expect(host.querySelectorAll(".ach-name.discovered")).toHaveLength(1);
  });

  it("fills the progress bar within the current tier's band, not from zero", async () => {
    const host = mount();
    await settle();

    // value 7 sits 2 above Copper (5) in a 20-wide band to Silver (25) → 10%.
    const fill = host.querySelector<HTMLElement>(
      "[data-achievement='worktree_wrangler'] .ach-card-bar-fill",
    )!;
    expect(fill.style.width).toBe("10%");
  });
});
