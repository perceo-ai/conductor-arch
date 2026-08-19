import net from "node:net";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";

// Node port of crates/core/src/archcar/{client,transport}.rs framing.
//
// Wire protocol: newline-delimited JSON. Each message is an envelope
//   { "id": "<uuid>", "payload": { ... } }
// One connection per request/response; a separate long-lived connection carries
// the `subscribe` event stream. Mirrors ArchcarClient::send / ::subscribe.

export interface RpcEnvelope<T> {
  id: string;
  payload: T;
}

const RPC_TIMEOUT_MS = 30_000;
const STARTUP_ATTEMPTS = 20;
const STARTUP_POLL_MS = 100;

let cachedPath: string | null = null;

function shellPath(): string {
  if (cachedPath != null) return cachedPath;
  const extra = [
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
    "/opt/homebrew/bin",
    "/home/linuxbrew/.linuxbrew/bin",
    path.join(os.homedir(), ".local/bin"),
    path.join(os.homedir(), "bin"),
  ];
  let base = process.env.PATH ?? "";
  try {
    const shell = process.env.SHELL || "/bin/sh";
    const out = execFileSync(shell, ["-lc", "printf %s \"$PATH\""], {
      encoding: "utf8",
      timeout: 3000,
    }).trim();
    if (out) base = out;
  } catch {
    // Fall back to the process PATH plus common install dirs.
  }
  cachedPath = [base, ...extra].filter(Boolean).join(":");
  return cachedPath;
}

function spawnEnv(): NodeJS.ProcessEnv {
  return { ...process.env, PATH: shellPath() };
}

function stateDir(): string {
  const xdg = process.env.XDG_STATE_HOME;
  const base = xdg && xdg.trim().length > 0 ? xdg : path.join(os.homedir(), ".local/state");
  return path.join(base, "archductor");
}

// UNIX_SOCKET_PATH_LIMIT is ~104-108 bytes; core falls back to a short hashed
// name when the direct path is too long. Keep this in lockstep with
// crates/core/src/paths.rs so deep Conductor workspaces can still auto-spawn.
const isWindows = process.platform === "win32";
const UNIX_SOCKET_PATH_LIMIT = 100;

export function endpointPath(): string {
  const override = process.env.ARCHDUCTOR_ARCHCAR_ENDPOINT;
  if (override && override.trim().length > 0) return override;
  if (isWindows) {
    // Windows core has no Unix sockets: it writes a `.endpoint` descriptor
    // (address + token) and serves over loopback TCP (see paths.rs +
    // transport.rs).
    return path.join(stateDir(), "archcar.endpoint");
  }
  const direct = path.join(stateDir(), "archcar.sock");
  if (Buffer.byteLength(direct) < UNIX_SOCKET_PATH_LIMIT) return direct;
  return shortUnixEndpoint(stateDir());
}

function shortUnixEndpoint(state: string): string {
  const name = `archcar-${stablePathHash(state)}.sock`;
  const bases = [
    process.env.XDG_RUNTIME_DIR,
    path.join(os.tmpdir(), "archductor"),
    "/tmp/archductor",
  ].filter((base): base is string => base !== undefined);
  for (const base of bases) {
    const candidate = path.join(base, name);
    if (Buffer.byteLength(candidate) < UNIX_SOCKET_PATH_LIMIT) return candidate;
  }
  return path.join("/tmp", name);
}

function stablePathHash(value: string): string {
  let hash = 0xcbf29ce484222325n;
  for (const byte of Buffer.from(value)) {
    hash = (hash ^ BigInt(byte)) * 0x100000001b3n;
    hash &= 0xffffffffffffffffn;
  }
  return hash.toString(16).padStart(16, "0");
}

function connectOnce(endpoint: string): Promise<net.Socket> {
  if (isWindows) return connectWindows(endpoint);
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(endpoint);
    socket.once("connect", () => resolve(socket));
    socket.once("error", reject);
  });
}

// --- Remote daemon (server-hosted execution) --------------------------------
// Mirrors crates/core/src/archcar/{remote,client}.rs: the environment
// (ARCHDUCTOR_ARCHCAR_REMOTE + ARCHDUCTOR_ARCHCAR_TOKEN) wins, then the
// remote profile the CLI writes with `archductor remote connect`
// (state/remote.json), then the local daemon. The profile file is shared with
// core so one `remote connect` moves every client on this machine.

export interface RemoteConfig {
  address: string;
  token: string;
}

export function remoteProfilePath(): string {
  return path.join(stateDir(), "remote.json");
}

/** Pure resolution (exported for tests): env beats profile beats local. */
export function resolveRemoteConfig(
  env: Record<string, string | undefined>,
  readProfile: () => string | null,
  readLocalToken: () => string | null,
): RemoteConfig | null {
  const address = env.ARCHDUCTOR_ARCHCAR_REMOTE?.trim();
  if (address) {
    const token = env.ARCHDUCTOR_ARCHCAR_TOKEN?.trim() || readLocalToken()?.trim();
    if (!token) {
      throw new Error(
        "ARCHDUCTOR_ARCHCAR_REMOTE is set but no token was found; set ARCHDUCTOR_ARCHCAR_TOKEN",
      );
    }
    return { address, token };
  }
  const raw = readProfile();
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { address?: string; token?: string };
    const parsedAddress = parsed.address?.trim();
    const parsedToken = parsed.token?.trim();
    if (parsedAddress && parsedToken) return { address: parsedAddress, token: parsedToken };
  } catch {
    // A malformed profile falls back to the local daemon rather than wedging
    // the app; `remote connect` rewrites it.
  }
  return null;
}

export function loadRemoteConfig(): RemoteConfig | null {
  const readFile = (p: string): string | null => {
    try {
      return fs.readFileSync(p, "utf8");
    } catch {
      return null;
    }
  };
  return resolveRemoteConfig(
    process.env,
    () => readFile(remoteProfilePath()),
    () => readFile(path.join(stateDir(), "archcar.token")),
  );
}

/** Connect to a remote archcar: TCP, then the token line before any framing. */
function connectRemote(config: RemoteConfig): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    // The daemon binds host:port; the last colon splits hostname from port.
    const sep = config.address.lastIndexOf(":");
    if (sep <= 0) {
      reject(new Error(`remote archcar address must be host:port, got ${config.address}`));
      return;
    }
    const host = config.address.slice(0, sep);
    const port = Number(config.address.slice(sep + 1));
    const socket = net.createConnection({ host, port });
    socket.once("error", reject);
    socket.once("connect", () => {
      socket.write(`${config.token}\n`);
      resolve(socket);
    });
  });
}

// Windows transport (mirrors transport.rs::connect on Windows): the `.endpoint`
// file holds "host:port\n<token>\n". Connect over loopback TCP and send the
// token line before any framing so the sidecar authenticates the connection.
function connectWindows(endpoint: string): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    let contents: string;
    try {
      contents = fs.readFileSync(endpoint, "utf8");
    } catch (err) {
      reject(err as Error);
      return;
    }
    const [address, token] = contents.split(/\r?\n/);
    if (!address || !token) {
      reject(new Error(`malformed archcar endpoint descriptor at ${endpoint}`));
      return;
    }
    // core binds 127.0.0.1 (IPv4), so the last colon separates host and port.
    const sep = address.lastIndexOf(":");
    const host = address.slice(0, sep);
    const port = Number(address.slice(sep + 1));
    const socket = net.createConnection({ host, port });
    socket.once("error", reject);
    socket.once("connect", () => {
      socket.write(`${token}\n`);
      resolve(socket);
    });
  });
}

function archcarBinary(): string {
  // 1. Explicit override.
  const override = process.env.ARCHDUCTOR_ARCHCAR_BIN;
  if (override && override.trim().length > 0) return override;
  // 2. Bundled sidecar shipped via electron-builder extraResources
  //    (resources/bin/archcar[.exe]). Self-contained so no PATH install needed.
  const exe = process.platform === "win32" ? "archcar.exe" : "archcar";
  const resources = process.resourcesPath;
  if (resources) {
    const bundled = path.join(resources, "bin", exe);
    if (fs.existsSync(bundled)) return bundled;
  }
  // 3. Fall back to PATH (dev / system install).
  return "archcar";
}

// Concurrent request + subscribe both call ensureDaemon at startup. Memoize the
// in-flight spawn-and-poll per endpoint so they share ONE archcar process
// instead of racing to spawn competing daemons. Cleared on settle so a later
// call can retry (and re-verify the connection) after a failure.
const daemonAttempts = new Map<string, Promise<void>>();

function ensureDaemon(endpoint: string): Promise<void> {
  let attempt = daemonAttempts.get(endpoint);
  if (!attempt) {
    attempt = ensureDaemonOnce(endpoint).finally(() => {
      daemonAttempts.delete(endpoint);
    });
    daemonAttempts.set(endpoint, attempt);
  }
  return attempt;
}

async function ensureDaemonOnce(endpoint: string): Promise<void> {
  try {
    const s = await connectOnce(endpoint);
    s.destroy();
    return;
  } catch {
    // not up yet
  }
  // Spawn detached; it binds the endpoint itself.
  const child = spawn(archcarBinary(), [], {
    detached: true,
    stdio: "ignore",
    env: spawnEnv(),
  });
  child.unref();

  for (let i = 0; i < STARTUP_ATTEMPTS; i++) {
    if (fs.existsSync(endpoint)) {
      try {
        const s = await connectOnce(endpoint);
        s.destroy();
        return;
      } catch {
        // keep polling
      }
    }
    await new Promise((r) => setTimeout(r, STARTUP_POLL_MS));
  }
  throw new Error(`archcar did not come up at ${endpoint}`);
}

/** Read newline-delimited JSON envelopes off a socket, invoking `onLine` per line. */
function lineReader(socket: net.Socket, onLine: (line: string) => void): void {
  let buf = "";
  socket.setEncoding("utf8");
  socket.on("data", (chunk: string) => {
    buf += chunk;
    let idx: number;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx);
      buf = buf.slice(idx + 1);
      if (line.trim().length > 0) onLine(line);
    }
  });
}

export class ArchcarBridge {
  // Resolved lazily: endpointPath() can throw (e.g. an over-long socket path
  // with no override). Computing it in the constructor would throw at module
  // load in the main process, so the window is never created and the app fails
  // silently. Deferring to first use surfaces the error through the IPC handler
  // instead, and still lets the window open.
  private endpoint: string | null;
  private subSocket: net.Socket | null = null;

  constructor(endpoint?: string) {
    this.endpoint = endpoint ?? null;
  }

  private resolveEndpoint(): string {
    if (this.endpoint === null) this.endpoint = endpointPath();
    return this.endpoint;
  }

  /**
   * Open one connection: a configured remote daemon (never spawns a sidecar),
   * or the local endpoint (spawning archcar if needed). Remote config is
   * re-read per connection so a settings change applies without a restart.
   */
  private async open(): Promise<net.Socket> {
    const remote = loadRemoteConfig();
    if (remote) return connectRemote(remote);
    const endpoint = this.resolveEndpoint();
    await ensureDaemon(endpoint);
    return connectOnce(endpoint);
  }

  async request<Req, Res>(payload: Req): Promise<Res> {
    const socket = await this.open();
    const envelope: RpcEnvelope<Req> = { id: randomUUID(), payload };
    return new Promise<Res>((resolve, reject) => {
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new Error("archcar request timed out"));
      }, RPC_TIMEOUT_MS);

      let settled = false;
      lineReader(socket, (line) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.end();
        try {
          const res = JSON.parse(line) as RpcEnvelope<Res>;
          resolve(res.payload);
        } catch (err) {
          reject(err);
        }
      });
      socket.once("error", (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(err);
      });
      socket.write(JSON.stringify(envelope) + "\n");
    });
  }

  /** Open the persistent event stream. `onEvent` fires for each ArchcarEvent. */
  async subscribe(onEvent: (event: unknown) => void, onClose: () => void): Promise<void> {
    const socket = await this.open();
    this.subSocket = socket;
    const envelope: RpcEnvelope<{ type: "subscribe" }> = {
      id: randomUUID(),
      payload: { type: "subscribe" },
    };
    socket.write(JSON.stringify(envelope) + "\n");
    lineReader(socket, (line) => {
      try {
        const env = JSON.parse(line) as RpcEnvelope<unknown>;
        onEvent(env.payload);
      } catch {
        // ignore malformed line
      }
    });
    socket.once("close", onClose);
    socket.once("error", onClose);
  }

  close(): void {
    this.subSocket?.destroy();
    this.subSocket = null;
  }
}
