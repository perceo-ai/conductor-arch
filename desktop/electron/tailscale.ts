import { execFile } from "node:child_process";
import net from "node:net";

// Find Archductor daemons on this machine's tailnet so the client switcher can
// suggest them. Mirrors crates/core/src/archcar/tailscale.rs — keep the two in
// step (same filters, same probe, same address preference).
//
// Probe: send a deliberately wrong token line to the archcar listener; a real
// daemon answers with its fixed "authentication failed" envelope, which no
// other service sends. No credential leaves this machine.

export const DEFAULT_REMOTE_PORT = 7420;
export const PROBE_TOKEN_LINE = "archductor discovery probe\n";
export const AUTH_FAILURE_MARKER = "archcar authentication failed";
const PROBE_TIMEOUT_MS = 900;
const TAILSCALE_CANDIDATES = ["tailscale", "/Applications/Tailscale.app/Contents/MacOS/Tailscale"];

export interface RawPeer {
  HostName?: string;
  DNSName?: string;
  OS?: string;
  TailscaleIPs?: string[];
  Online?: boolean;
  sshHostKeys?: string[] | null;
}

export interface TailscalePeer {
  host_name: string;
  dns_name: string;
  ip: string;
  os: string;
  archcar_listener: boolean;
  listener_port: number;
  tailscale_ssh: boolean;
  transport: "ssh" | "tcp";
  suggested_address: string;
  needs_token: boolean;
  saved: boolean;
}

function peerIp(peer: RawPeer): string | null {
  const ips = peer.TailscaleIPs ?? [];
  return ips.find((ip) => ip.includes(".")) ?? ips[0] ?? null;
}

/** Online, non-mobile peers with an address, sorted by host name. */
export function parseStatus(json: string): RawPeer[] {
  const status = JSON.parse(json) as { BackendState?: string; Peer?: Record<string, RawPeer> | null };
  if (status.BackendState && status.BackendState !== "Running") {
    throw new Error(`Tailscale is not connected on this machine (state: ${status.BackendState})`);
  }
  return Object.values(status.Peer ?? {})
    .filter((p) => p.Online && peerIp(p) !== null)
    .filter((p) => !["ios", "android"].includes((p.OS ?? "").toLowerCase()))
    .sort((a, b) => (a.HostName ?? "").toLowerCase().localeCompare((b.HostName ?? "").toLowerCase()));
}

/** Bare host of a client address (drops ssh://, user@, :port, path, trailing dot). */
export function addressHost(address: string): string {
  let rest = address.trim();
  if (rest.startsWith("ssh://")) rest = rest.slice("ssh://".length);
  rest = rest.split("/")[0] ?? "";
  rest = rest.slice(rest.lastIndexOf("@") + 1);
  let host: string;
  if (rest.startsWith("[")) {
    host = rest.slice(1).split("]")[0] ?? "";
  } else {
    const colon = rest.lastIndexOf(":");
    host = colon >= 0 && /^\d*$/.test(rest.slice(colon + 1)) ? rest.slice(0, colon) : rest;
  }
  return host.replace(/\.+$/, "");
}

/** The suggestion for a probed peer, or null when there is no way in. */
export function suggest(
  raw: RawPeer,
  archcarListener: boolean,
  port: number,
  savedAddresses: string[],
): TailscalePeer | null {
  const ip = peerIp(raw);
  if (!ip) return null;
  const dnsName = (raw.DNSName ?? "").replace(/\.+$/, "");
  const tailscaleSsh = (raw.sshHostKeys ?? []).length > 0;
  if (!archcarListener && !tailscaleSsh) return null;
  const host = dnsName || ip;
  const transport = tailscaleSsh ? "ssh" : "tcp";
  const names = [ip, dnsName, raw.HostName ?? ""].filter(Boolean).map((n) => n.toLowerCase());
  const saved = savedAddresses.some((address) => {
    const h = addressHost(address).toLowerCase();
    return h !== "" && names.includes(h);
  });
  return {
    host_name: raw.HostName ?? "",
    dns_name: dnsName,
    ip,
    os: raw.OS ?? "",
    archcar_listener: archcarListener,
    listener_port: port,
    tailscale_ssh: tailscaleSsh,
    transport,
    suggested_address: transport === "ssh" ? `ssh://${host}` : `${host}:${port}`,
    needs_token: transport === "tcp",
    saved,
  };
}

/** Whether an archcar listener answers at host:port. */
export function probeArchcar(host: string, port: number, timeoutMs = PROBE_TIMEOUT_MS): Promise<boolean> {
  return new Promise((resolve) => {
    let buffer = "";
    let settled = false;
    const finish = (value: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(value);
    };
    const socket = net.connect({ host, port });
    socket.setTimeout(timeoutMs, () => finish(false));
    socket.on("connect", () => socket.write(PROBE_TOKEN_LINE));
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      if (buffer.includes("\n") || buffer.length > 1024) finish(buffer.includes(AUTH_FAILURE_MARKER));
    });
    socket.on("end", () => finish(buffer.includes(AUTH_FAILURE_MARKER)));
    socket.on("error", () => finish(false));
  });
}

function run(program: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(program, args, { timeout: 5000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(Object.assign(err, { stderr: String(stderr ?? "") }));
      else resolve({ stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

export async function statusJson(): Promise<string> {
  let lastError: Error | null = null;
  for (const program of TAILSCALE_CANDIDATES) {
    try {
      return (await run(program, ["status", "--json"])).stdout;
    } catch (err) {
      const e = err as NodeJS.ErrnoException & { stderr?: string };
      if (e.code === "ENOENT") continue;
      lastError = new Error(`\`tailscale status\` failed: ${e.stderr?.trim() || e.message}`);
    }
  }
  throw lastError ?? new Error("the `tailscale` CLI is not installed");
}

/** Discover suggestable peers; probes run in parallel. */
export async function discoverTailscalePeers(
  savedAddresses: string[],
  port = DEFAULT_REMOTE_PORT,
): Promise<TailscalePeer[]> {
  const peers = parseStatus(await statusJson());
  const probed = await Promise.all(
    peers.map(async (peer) => [peer, await probeArchcar(peerIp(peer)!, port)] as const),
  );
  return probed
    .map(([peer, listener]) => suggest(peer, listener, port, savedAddresses))
    .filter((p): p is TailscalePeer => p !== null);
}
