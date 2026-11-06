import { For, Show, createMemo, createSignal, onMount } from "solid-js";
import Icon from "@/components/Icon";
import { achievementsStore } from "@/store";
import type { AchievementProgress } from "@/bridge/protocol";

// Achievements page — a deliberately unserious surface next to Settings. The
// daemon derives everything from rows it already keeps (one RPC, on open), so
// this page owns no live state and never polls.

type Tab = "achievements" | "discovery";

/** Tier ladder, lowest first. Must match `TIER_NAMES` in the core crate. */
const TIER_CLASS: Record<string, string> = {
  Copper: "copper",
  Silver: "silver",
  Gold: "gold",
  Diamond: "diamond",
  Olympian: "olympian",
};

function percent(entry: AchievementProgress): number {
  const next = entry.next_threshold;
  if (next == null) return 100;
  // Progress is measured inside the current tier's band, not from zero, so a
  // Gold card does not sit at a near-full bar forever on the way to Diamond.
  const earned = entry.tier ?? 0;
  const floor = earned > 0 ? (entry.tier_thresholds[earned - 1] ?? 0) : 0;
  const span = next - floor;
  if (span <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round(((entry.value - floor) / span) * 100)));
}

function AchievementCard(props: { entry: AchievementProgress }) {
  const [open, setOpen] = createSignal(false);
  const entry = () => props.entry;
  const tierName = () => entry().tier_name ?? undefined;
  return (
    <div
      class="ach-card"
      classList={{ locked: entry().tier == null }}
      data-tier={tierName() ? TIER_CLASS[tierName()!] : "none"}
      data-achievement={entry().id}
    >
      <div class="ach-card-head">
        <span class="ach-card-name">{entry().name}</span>
        <Show when={tierName()} fallback={<span class="ach-tier none">Locked</span>}>
          <span class="ach-tier">{tierName()}</span>
        </Show>
      </div>
      <div class="ach-card-desc">{entry().description}</div>
      <div class="ach-card-bar">
        <div class="ach-card-bar-fill" style={{ width: `${percent(entry())}%` }} />
      </div>
      <div class="ach-card-foot">
        <span class="ach-card-value">
          {entry().value.toLocaleString()}
          <Show when={entry().next_threshold != null} fallback={<> · maxed</>}>
            {" "}
            / {entry().next_threshold!.toLocaleString()}
          </Show>
        </span>
        <button class="ach-card-more" onClick={() => setOpen((value) => !value)}>
          {open() ? "Hide" : "What counts"}
        </button>
      </div>
      <Show when={open()}>
        <div class="ach-card-counts">
          <div>{entry().counts}</div>
          <div class="ach-card-tiers">
            <For each={entry().tier_thresholds}>
              {(threshold, index) => (
                <span classList={{ earned: (entry().tier ?? 0) > index() }}>
                  {["Copper", "Silver", "Gold", "Diamond", "Olympian"][index()]}{" "}
                  {threshold.toLocaleString()}
                </span>
              )}
            </For>
          </div>
        </div>
      </Show>
    </div>
  );
}

export function AchievementsPage() {
  const [tab, setTab] = createSignal<Tab>("achievements");
  const [showLocked, setShowLocked] = createSignal(true);

  onMount(() => {
    void achievementsStore.load();
  });

  const summary = achievementsStore.summary;

  /** Visible entries grouped by category, catalog order preserved. */
  const groups = createMemo(() => {
    const all = summary()?.achievements ?? [];
    const visible = all.filter((entry) => {
      // Secret entries stay hidden until their metric moves at all: seeing
      // "Permission Denied Any%" before it happens spoils the joke.
      if (entry.secret && entry.tier == null && entry.value === 0) return false;
      return showLocked() || entry.tier != null;
    });
    const byCategory = new Map<string, AchievementProgress[]>();
    for (const entry of visible) {
      const bucket = byCategory.get(entry.category) ?? [];
      bucket.push(entry);
      byCategory.set(entry.category, bucket);
    }
    return [...byCategory.entries()];
  });

  const hiddenSecrets = createMemo(
    () =>
      (summary()?.achievements ?? []).filter(
        (entry) => entry.secret && entry.tier == null && entry.value === 0,
      ).length,
  );

  return (
    <div class="page-shell achievements-view">
      <div class="page-header dashboard-header">
        <div class="dashboard-title">Achievements</div>
        <div class="ach-header-row">
          <div class="project-tabs">
            <button
              class="ws-tab-shell"
              classList={{ active: tab() === "achievements" }}
              onClick={() => setTab("achievements")}
            >
              Badges
            </button>
            <button
              class="ws-tab-shell"
              classList={{ active: tab() === "discovery" }}
              onClick={() => setTab("discovery")}
            >
              Discovery
            </button>
          </div>
          <button
            class="ui-button-secondary ach-rescan"
            onClick={() => void achievementsStore.refresh()}
            disabled={achievementsStore.loading()}
          >
            {achievementsStore.loading() ? "Scanning…" : "Rescan"}
          </button>
        </div>
      </div>

      <Show when={achievementsStore.error()}>
        {(message) => <div class="empty-state">Could not load achievements: {message()}</div>}
      </Show>

      <Show
        when={summary()}
        fallback={
          <Show when={!achievementsStore.error()}>
            <div class="empty-state">Reading your history…</div>
          </Show>
        }
      >
        {(loaded) => (
          <>
            <div class="ach-scoreboard">
              <div class="ach-score">
                <Icon name="trophy" class="ach-score-icon" />
                <span class="ach-score-value">
                  {loaded().unlocked}/{loaded().total}
                </span>
                <span class="ach-score-label">unlocked</span>
              </div>
              <div class="ach-score">
                <span class="ach-score-value">{loaded().tiers_earned}</span>
                <span class="ach-score-label">tiers earned</span>
              </div>
              <div class="ach-score">
                <span class="ach-score-value">
                  {loaded().discovery.discovered}/{loaded().discovery.total}
                </span>
                <span class="ach-score-label">names discovered</span>
              </div>
            </div>

            <Show when={tab() === "achievements"}>
              <div class="ach-body">
                <label class="ach-toggle">
                  <input
                    type="checkbox"
                    checked={showLocked()}
                    onChange={(event) => setShowLocked(event.currentTarget.checked)}
                  />
                  Show locked
                </label>
                <For each={groups()}>
                  {([category, entries]) => (
                    <section class="ach-group">
                      <h3 class="ach-group-title">{category}</h3>
                      <div class="ach-grid">
                        <For each={entries}>{(entry) => <AchievementCard entry={entry} />}</For>
                      </div>
                    </section>
                  )}
                </For>
                <Show when={hiddenSecrets() > 0}>
                  <div class="ach-secret-note">
                    {hiddenSecrets()} secret achievement
                    {hiddenSecrets() === 1 ? "" : "s"} still hidden. They reveal themselves when
                    something goes wrong.
                  </div>
                </Show>
              </div>
            </Show>

            <Show when={tab() === "discovery"}>
              <div class="ach-body">
                <div class="ach-discovery-note">
                  Archductor names new workspaces after Linux distributions. These are the ones you
                  have met.
                </div>
                <div class="ach-names">
                  <For each={loaded().discovery.names}>
                    {(entry) => (
                      <span
                        class="ach-name"
                        classList={{ discovered: entry.discovered }}
                        title={entry.discovered ? "Discovered" : "Not yet discovered"}
                      >
                        {entry.discovered ? entry.name : "?".repeat(Math.min(entry.name.length, 8))}
                      </span>
                    )}
                  </For>
                </div>
              </div>
            </Show>
          </>
        )}
      </Show>
    </div>
  );
}
