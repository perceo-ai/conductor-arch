import { describe, expect, it } from "vitest";
import type { DaemonUpdateStatus } from "@/bridge/protocol";
import { daemonUpdateSummary } from "./daemonUpdate";

function status(overrides: Partial<DaemonUpdateStatus> = {}): DaemonUpdateStatus {
  return {
    current_version: "0.8.2",
    latest_version: "0.8.3",
    update_available: true,
    channel: "tarball",
    binary_path: "/home/me/archductor/bin/archcar",
    restart_pending: false,
    can_self_update: true,
    auto_update: false,
    ...overrides,
  };
}

describe("daemonUpdateSummary", () => {
  it("offers to install when the daemon can update itself", () => {
    expect(daemonUpdateSummary(status())).toEqual({
      headline: "v0.8.2 · v0.8.3 available",
      action: { label: "Update to v0.8.3", kind: "install" },
    });
  });

  it("offers a restart when a newer binary is already on disk", () => {
    // A package manager or the desktop app installed it; the running daemon
    // just has not picked it up.
    const summary = daemonUpdateSummary(
      status({ channel: "apt", can_self_update: false, restart_pending: true, on_disk_version: "0.8.3" }),
    );
    expect(summary.action).toEqual({ label: "Restart onto v0.8.3", kind: "restart" });
  });

  it("gives the channel's own command instead of a button it cannot honour", () => {
    const summary = daemonUpdateSummary(
      status({
        channel: "homebrew",
        can_self_update: false,
        guidance: "run `brew upgrade archductor` on that machine, then apply to restart",
      }),
    );
    expect(summary.action).toBeUndefined();
    expect(summary.guidance).toContain("brew upgrade");
  });

  it("says up to date, and says so honestly when it has not checked", () => {
    expect(daemonUpdateSummary(status({ update_available: false, latest_version: "0.8.2" })).headline).toBe(
      "v0.8.2 · up to date",
    );
    expect(
      daemonUpdateSummary(status({ update_available: false, latest_version: undefined })).headline,
    ).toBe("v0.8.2 · not checked for updates yet");
  });

  it("never offers anything for a development build", () => {
    const summary = daemonUpdateSummary(
      status({ channel: "development", can_self_update: false, update_available: false, guidance: "rebuild it" }),
    );
    expect(summary.action).toBeUndefined();
    expect(summary.headline).toContain("development build");
  });
});
