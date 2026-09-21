import { describe, expect, it } from "vitest";

import { buildPairingPayload, renderPairingQr } from "./pairing";

describe("buildPairingPayload", () => {
  it("uses the daemon's own listen address when it has one", () => {
    const result = buildPairingPayload({
      label: "studio",
      listen: "0.0.0.0:7420",
      token: "abc",
      fallbackHost: "studio.local",
    });
    expect(result).toEqual({
      ok: true,
      // A wildcard bind is not an address a phone can dial, so the host the
      // desktop knows itself by is substituted while the port is kept.
      payload: JSON.stringify({ v: 1, label: "studio", token: "abc", address: "studio.local:7420" }),
      address: "studio.local:7420",
    });
  });

  it("keeps a concrete listen host", () => {
    const result = buildPairingPayload({
      label: "studio",
      listen: "100.90.1.2:7420",
      token: "abc",
      fallbackHost: "studio.local",
    });
    expect(result).toEqual({
      ok: true,
      payload: JSON.stringify({ v: 1, label: "studio", token: "abc", address: "100.90.1.2:7420" }),
      address: "100.90.1.2:7420",
    });
  });

  it("refuses to pair when the daemon has no listener", () => {
    const result = buildPairingPayload({
      label: "studio",
      listen: null,
      token: "abc",
      fallbackHost: "studio.local",
    });
    expect(result).toEqual({
      ok: false,
      error: "This daemon has no remote listener. Enable phone access first.",
    });
  });

  it("refuses to pair a loopback-only listener", () => {
    const result = buildPairingPayload({
      label: "studio",
      listen: "127.0.0.1:7420",
      token: "abc",
      fallbackHost: "studio.local",
    });
    expect(result).toEqual({
      ok: false,
      error: "This daemon only listens on loopback, which a phone cannot reach.",
    });
  });

  it("refuses an unreadable listen address", () => {
    const result = buildPairingPayload({
      label: "studio",
      listen: "not-an-address",
      token: "abc",
      fallbackHost: "studio.local",
    });
    expect(result).toEqual({
      ok: false,
      error: 'Could not read the listen address "not-an-address".',
    });
  });

  it("refuses to build a payload without a token", () => {
    const result = buildPairingPayload({
      label: "studio",
      listen: "10.0.0.4:7420",
      token: "",
      fallbackHost: "studio.local",
    });
    expect(result).toEqual({
      ok: false,
      error: "This daemon has no access token yet. Install the background service first.",
    });
  });
});

describe("renderPairingQr", () => {
  it("produces scannable SVG markup", async () => {
    const svg = await renderPairingQr(
      JSON.stringify({ v: 1, label: "x", address: "h:1", token: "t" }),
    );
    expect(svg).toContain("<svg");
    expect(svg).toContain("</svg>");
  });
});
