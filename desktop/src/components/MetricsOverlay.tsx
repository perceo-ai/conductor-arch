import { For, Show } from "solid-js";
import { updateMetrics, metricsEnabled } from "@/store";

// Dev overlay: live per-store-key update counts. Proves rerenders stay scoped —
// e.g. typing in thread 7 should only bump chat.*.7 keys. Port of the intent of
// refresh.rs RefreshMetrics logging.
export default function MetricsOverlay() {
  return (
    <Show when={metricsEnabled}>
      <div class="metrics-overlay">
        <For each={Object.entries(updateMetrics())}>
          {([key, n]) => (
            <div>
              {key}: {n as number}
            </div>
          )}
        </For>
      </div>
    </Show>
  );
}
