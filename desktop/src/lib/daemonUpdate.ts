// What the connected daemon says about its own version and install, turned
// into the one line and the one button Settings shows. The daemon decides
// what is possible (only it knows where it was installed from); this only
// words it, so the CLI's `archductor remote update --check` and this row say
// the same thing.

import type { DaemonUpdateStatus } from "@/bridge/protocol";

export interface DaemonUpdateSummary {
  headline: string;
  /** How to update when the daemon cannot do it itself. */
  guidance?: string;
  /** The button, when applying would change the running version. */
  action?: { label: string; kind: "restart" | "install" };
}

export function daemonUpdateSummary(status: DaemonUpdateStatus): DaemonUpdateSummary {
  const running = `v${status.current_version}`;
  if (status.channel === "development") {
    return { headline: `${running} · development build`, guidance: status.guidance };
  }
  if (status.restart_pending) {
    return {
      headline: `${running} running · v${status.on_disk_version} installed`,
      action: { label: `Restart onto v${status.on_disk_version}`, kind: "restart" },
    };
  }
  if (!status.latest_version) {
    return { headline: `${running} · not checked for updates yet` };
  }
  if (!status.update_available) {
    return { headline: `${running} · up to date` };
  }
  if (status.can_self_update) {
    return {
      headline: `${running} · v${status.latest_version} available`,
      action: { label: `Update to v${status.latest_version}`, kind: "install" },
    };
  }
  return {
    headline: `${running} · v${status.latest_version} available`,
    guidance: status.guidance,
  };
}
