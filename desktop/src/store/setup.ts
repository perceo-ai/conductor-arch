import { createSignal } from "solid-js";

import { send } from "@/bridge/client";
import { logAction, logState } from "@/lib/log";
import type { SetupReport } from "@/bridge/protocol";

// Host setup readiness (GitHub CLI + agent providers). The app probes once on
// startup; if setup is incomplete a blocking modal is shown until the user
// installs/authenticates the missing tools and rechecks. Mirrors the retired
// GTK `show_blocking_setup_if_needed` flow, now driven by an archcar RPC.

const [report, setReport] = createSignal<SetupReport | null>(null);
const [checking, setChecking] = createSignal(false);

/**
 * Probe archcar for setup readiness. `recheck` refreshes the daemon's process
 * environment first so a just-installed tool is picked up.
 */
async function probe(recheck: boolean): Promise<SetupReport> {
  logAction("setup readiness probe", { recheck });
  setChecking(true);
  try {
    const res = await send({ type: "get_setup_readiness", recheck });
    if (res.type === "error") throw new Error(res.message);
    if (res.type !== "setup_readiness") {
      throw new Error(`unexpected response ${res.type}`);
    }
    setReport(res.report);
    logState("setup readiness", { complete: res.report.complete });
    return res.report;
  } finally {
    setChecking(false);
  }
}

export const setupStore = {
  report,
  checking,
  /** Whether the blocking setup modal should be shown. */
  blocked: () => {
    const r = report();
    return r != null && !r.complete;
  },
  /** Initial probe on app startup (no environment refresh). */
  check: () => probe(false),
  /** User pressed "Recheck": refresh environment, then re-probe. */
  recheck: () => probe(true),
};
