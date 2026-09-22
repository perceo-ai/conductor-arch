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

/** One entry of `os.networkInterfaces()`, narrowed to what matters here. */
export interface PairingInterface {
  address: string;
  family: string | number;
  internal: boolean;
}

/**
 * The address to advertise when the daemon binds a wildcard.
 *
 * The hostname was the only answer, and `<machine>.local` is an mDNS name: it
 * resolves on the same LAN and nowhere else, so a phone on a VPN — the setup
 * this pairing flow is most useful for — reads the code and cannot connect.
 * A tailnet address is preferred because it reaches the machine from anywhere
 * the VPN does, then a private LAN address, and only then the hostname.
 */
export function preferredPairingHost(
  interfaces: Record<string, PairingInterface[] | undefined>,
  hostname: string,
): string {
  const candidates = Object.values(interfaces)
    .flatMap((entries) => entries ?? [])
    .filter((entry) => !entry.internal && (entry.family === "IPv4" || entry.family === 4));
  // 100.64.0.0/10: carrier-grade NAT space, which is what Tailscale hands out.
  const tailnet = candidates.find((entry) => {
    const [a, b] = entry.address.split(".").map(Number);
    return a === 100 && b >= 64 && b <= 127;
  });
  if (tailnet) return tailnet.address;
  const lan = candidates.find((entry) => {
    const [a, b] = entry.address.split(".").map(Number);
    return a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31);
  });
  return lan?.address ?? hostname;
}

export function renderPairingQr(payload: string): Promise<string> {
  return QRCode.toString(payload, { type: "svg", errorCorrectionLevel: "M", margin: 1 });
}

/**
 * The page shown in the isolated pairing window.
 *
 * A QR code *is* the token, just in a form a camera can read, so handing the
 * SVG to the app's renderer would put a credential that grants shell and
 * repository access inside the process most exposed to hostile content. The
 * markup therefore never leaves main except into a dedicated window that runs
 * no application code: no preload, no node integration, sandboxed, and loaded
 * from a data URL.
 */
export function pairingWindowHtml(svg: string, address: string): string {
  const safeAddress = address.replace(/[&<>"']/g, (character) => {
    switch (character) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      default:
        return "&#39;";
    }
  });
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:" />
    <title>Pair a phone</title>
    <style>
      body {
        margin: 0;
        padding: 20px;
        font: 13px -apple-system, "Segoe UI", sans-serif;
        background: #f3f3f5;
        color: #1c1c1e;
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 12px;
      }
      .code { width: 260px; height: 260px; padding: 10px; background: #fff; border-radius: 10px; }
      .code svg { width: 100%; height: 100%; display: block; }
      .address { font-family: ui-monospace, monospace; }
      .warning { max-width: 300px; text-align: center; color: #8a5a00; }
    </style>
  </head>
  <body>
    <div class="code">${svg}</div>
    <div class="address">${safeAddress}</div>
    <div class="warning">
      Anyone who scans this gains full control of this machine. Close this
      window once the phone has paired.
    </div>
  </body>
</html>`;
}
