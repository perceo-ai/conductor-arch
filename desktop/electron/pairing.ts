import QRCode from "qrcode";

// Builds what a phone needs to reach this daemon, and renders it as a QR code.
//
// The token is a live credential: whoever photographs this code can drive this
// machine. It is built and rendered here, in main, so the renderer only ever
// holds SVG markup — the same rule the saved-clients list already follows.

export interface PairingInput {
  label: string;
  /** The daemon's listen address, or null when it has no remote listener. */
  listen: string | null;
  token: string;
  /** Host to substitute when the daemon binds a wildcard address. */
  fallbackHost: string;
}

export type PairingResult =
  | { ok: true; payload: string; address: string }
  | { ok: false; error: string };

const WILDCARD_HOSTS = new Set(["0.0.0.0", "::", "[::]"]);
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

function splitHostPort(listen: string): { host: string; port: string } | null {
  const match = /^(\[[^\]]+\]|[^:]+):(\d+)$/.exec(listen.trim());
  if (!match) return null;
  return { host: match[1], port: match[2] };
}

export function buildPairingPayload(input: PairingInput): PairingResult {
  if (!input.listen) {
    return { ok: false, error: "This daemon has no remote listener. Enable phone access first." };
  }
  if (!input.token) {
    return {
      ok: false,
      error: "This daemon has no access token yet. Install the background service first.",
    };
  }
  const parts = splitHostPort(input.listen);
  if (!parts) {
    return { ok: false, error: `Could not read the listen address "${input.listen}".` };
  }
  if (LOOPBACK_HOSTS.has(parts.host)) {
    return { ok: false, error: "This daemon only listens on loopback, which a phone cannot reach." };
  }
  const host = WILDCARD_HOSTS.has(parts.host) ? input.fallbackHost : parts.host;
  const address = `${host}:${parts.port}`;
  return {
    ok: true,
    address,
    payload: JSON.stringify({ v: 1, label: input.label, token: input.token, address }),
  };
}

export function renderPairingQr(payload: string): Promise<string> {
  return QRCode.toString(payload, { type: "svg", errorCorrectionLevel: "M", margin: 1 });
}
