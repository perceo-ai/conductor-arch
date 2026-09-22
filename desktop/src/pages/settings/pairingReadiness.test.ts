import { describe, expect, it } from "vitest";
import { pairingReadiness } from "./pairingReadiness";
import { SETTINGS_SECTIONS } from "./SettingsControls";

describe("pairingReadiness", () => {
  it("is ready when the daemon listens somewhere a phone can reach", () => {
    expect(pairingReadiness({ listen: "0.0.0.0:7420", token: "t" })).toEqual({
      ready: true,
      address: "0.0.0.0:7420",
    });
  });

  it("names the fix when there is no listener at all", () => {
    const state = pairingReadiness({ listen: null, token: "t" });
    expect(state.ready).toBe(false);
    expect(state).toMatchObject({ fix: expect.stringContaining("0.0.0.0:7420") });
  });

  it("rejects a loopback listener, which a phone cannot reach", () => {
    for (const listen of ["127.0.0.1:7420", "localhost:7420", "[::1]:7420"]) {
      const state = pairingReadiness({ listen, token: "t" });
      expect(state.ready, listen).toBe(false);
    }
  });

  it("rejects an unparseable listen address", () => {
    expect(pairingReadiness({ listen: "not-an-address", token: "t" }).ready).toBe(false);
  });

  it("asks for a restart when the address is configured but unserved", () => {
    const state = pairingReadiness({ listen: null, token: "t" }, "0.0.0.0:7420");
    expect(state).toMatchObject({
      ready: false,
      reason: expect.stringContaining("0.0.0.0:7420"),
      fix: expect.stringContaining("Quit and reopen"),
    });
  });

  it("rejects a reachable listener with no token", () => {
    expect(pairingReadiness({ listen: "0.0.0.0:7420", token: "" }).ready).toBe(false);
  });

  it("reports unreadable settings rather than claiming readiness", () => {
    expect(pairingReadiness(null).ready).toBe(false);
  });
});

describe("settings search keywords", () => {
  const find = (needle: string) =>
    SETTINGS_SECTIONS.filter(
      (section) =>
        section.label.toLowerCase().includes(needle) ||
        section.group.toLowerCase().includes(needle) ||
        (section.keywords ?? []).some((keyword) => keyword.includes(needle)),
    ).map((section) => section.id);

  it("finds the pairing section by what it does, not its name", () => {
    for (const needle of ["pair", "phone", "ios", "iphone", "qr", "mobile"]) {
      expect(find(needle), needle).toContain("clients");
    }
  });
});
