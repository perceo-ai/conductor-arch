import net from "node:net";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { Duplex } from "node:stream";

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
  /**
   * Set when the address is an `ssh://` one. The transport is then an `ssh`
   * child running the stdio proxy on the far side, and `token` is unused —
   * sshd has already authenticated the caller.
   */
  ssh?: SshTarget;
}

/** Mirrors `SshTarget` in crates/core/src/archcar/remote.rs. */
export interface SshTarget {
  destination: string;
  port: number | null;
  program: string;
}

const SSH_SCHEME = "ssh://";
const DEFAULT_SSH_PROGRAM = "archductor";
const SSH_PROXY_ARGS = ["archcar", "stdio-proxy", "--quiet"];

export function isSshAddress(value: string): boolean {
  return value.trim().startsWith(SSH_SCHEME);
}

/**
 * Parse `ssh://[user@]host[:port][/path/to/archductor]`. Returns null for a
 * non-ssh address; throws for an ssh address that is malformed, because
 * falling back to the TCP transport would demand a token the user never meant
 * to supply.
 */
export function parseSshAddress(value: string): SshTarget | null {
  const trimmed = value.trim();
  if (!trimmed.startsWith(SSH_SCHEME)) return null;
  const rest = trimmed.slice(SSH_SCHEME.length);
  if (!rest) throw new Error("ssh address needs a host");

  const slash = rest.indexOf("/");
  const authority = slash >= 0 ? rest.slice(0, slash) : rest;
  const programPart = slash >= 0 ? rest.slice(slash).trim() : "";
  if (!authority) throw new Error("ssh address needs a host");

  let destination = authority;
  let port: number | null = null;
  // A bracketed IPv6 literal has no port suffix to split off.
  if (!authority.endsWith("]")) {
    const colon = authority.lastIndexOf(":");
    if (colon >= 0) {
      const parsed = Number(authority.slice(colon + 1));
      if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65535) {
        throw new Error(`ssh address port \`${authority.slice(colon + 1)}\` is not a port`);
      }
      destination = authority.slice(0, colon);
      port = parsed;
    }
  }
  if (!destination) throw new Error(`ssh address \`${rest}\` has no host part`);
  return {
    destination,
    port,
    program: programPart && programPart !== "/" ? programPart : DEFAULT_SSH_PROGRAM,
  };
}

/** The `ssh` argument list. Mirrors `SshTarget::ssh_args`. */
export function sshArgs(target: SshTarget): string[] {
  const args = [
    // No pty: this is a byte pipe, and a pty would mangle it.
    "-T",
    "-o",
    "ServerAliveInterval=15",
    "-o",
    "ServerAliveCountMax=3",
    // The app has no terminal, so a password prompt would hang it.
    "-o",
    "BatchMode=yes",
  ];
  if (target.port !== null) args.push("-p", String(target.port));
  args.push(target.destination, target.program, ...SSH_PROXY_ARGS);
  return args;
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
    const ssh = parseSshAddress(address);
    if (ssh) return { address, token: "", ssh };
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
    // An ssh:// profile has no token by design; only the TCP transport needs
    // one, so only the TCP transport treats a blank token as incomplete.
    if (parsedAddress && isSshAddress(parsedAddress)) {
      const ssh = parseSshAddress(parsedAddress);
      if (ssh) return { address: parsedAddress, token: "", ssh };
    }
    if (parsedAddress && parsedToken) return { address: parsedAddress, token: parsedToken };
  } catch {
    // A malformed profile falls back to the local daemon rather than wedging
    // the app; `remote connect` rewrites it.
  }
  return null;
}

// --- Saved clients -----------------------------------------------------------
// Mirrors crates/core/src/archcar/remote.rs: `clients.json` is the list of
// daemons this machine knows, `remote.json` is the selection. Writing the
// mirror on every change is what lets the CLI, MCP, and this bridge keep
// reading one file while the switcher manages many.

export interface ClientProfile {
  id: string;
  label: string;
  address: string;
  token: string;
}

/** On-disk shape — snake_case `active_id` matches the Rust serde field. */
export interface ClientsFile {
  active_id?: string;
  clients: ClientProfile[];
}

export function clientsPath(): string {
  return path.join(stateDir(), "clients.json");
}

/** Slug for a label: lowercase, non-alphanumerics collapsed to single dashes. */
export function clientIdFrom(label: string): string {
  const id = label
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .toLowerCase()
    .replace(/^-+|-+$/g, "");
  return id || "client";
}

/**
 * Pure parse (exported for tests). Drops incomplete entries, forgets an active
 * id with no matching client, and adopts a pre-existing single profile so a
 * machine that only ever ran `remote connect` keeps its connection.
 */
/**
 * Mirrors `profile_is_usable` in crates/core/src/archcar/remote.rs. Only the
 * TCP transport needs a token; an `ssh://` entry with a blank one is complete,
 * not half-written. Requiring a token here dropped ssh clients from the list,
 * so the switcher showed "This machine" while every request went to the remote
 * daemon.
 */
function clientIsUsable(address: string | undefined, token: string | undefined): boolean {
  const trimmed = address?.trim();
  if (!trimmed) return false;
  return isSshAddress(trimmed) || !!token?.trim();
}

export function parseClients(raw: string | null, profileRaw: string | null): ClientsFile {
  let file: ClientsFile = { clients: [] };
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as Partial<ClientsFile>;
      file = {
        active_id: parsed.active_id,
        clients: Array.isArray(parsed.clients) ? parsed.clients : [],
      };
    } catch {
      // A malformed list falls back to the local daemon rather than wedging
      // the app; the next save rewrites it.
      file = { clients: [] };
    }
  }
  file.clients = file.clients.filter((c) => c && c.id && clientIsUsable(c.address, c.token));
  if (!file.clients.some((c) => c.id === file.active_id)) delete file.active_id;
  if (file.clients.length === 0 && profileRaw) {
    try {
      const profile = JSON.parse(profileRaw) as { address?: string; token?: string };
      const address = profile.address?.trim();
      const token = profile.token?.trim() ?? "";
      if (address && clientIsUsable(address, token)) {
        const id = clientIdFrom(address);
        file = { active_id: id, clients: [{ id, label: address, address, token }] };
      }
    } catch {
      // ignore
    }
  }
  return file;
}

/** Add or update by address, returning the client's id. */
export function upsertClient(
  file: ClientsFile,
  label: string | undefined,
  address: string,
  token: string,
): string {
  const trimmedAddress = address.trim();
  const trimmedToken = token.trim();
  const trimmedLabel = label?.trim();
  const existing = file.clients.find((c) => c.address === trimmedAddress);
  if (existing) {
    existing.token = trimmedToken;
    if (trimmedLabel) existing.label = trimmedLabel;
    return existing.id;
  }
  const base = clientIdFrom(trimmedLabel || trimmedAddress);
  let id = base;
  for (let n = 2; file.clients.some((c) => c.id === id); n += 1) id = `${base}-${n}`;
  file.clients.push({ id, label: trimmedLabel || trimmedAddress, address: trimmedAddress, token: trimmedToken });
  return id;
}

export function loadClients(): ClientsFile {
  const read = (p: string): string | null => {
    try {
      return fs.readFileSync(p, "utf8");
    } catch {
      return null;
    }
  };
  return parseClients(read(clientsPath()), read(remoteProfilePath()));
}

/** Persist the list owner-only and mirror the active client into remote.json. */
export function saveClients(file: ClientsFile): void {
  fs.mkdirSync(path.dirname(clientsPath()), { recursive: true });
  fs.writeFileSync(clientsPath(), JSON.stringify(file, null, 2) + "\n", { mode: 0o600 });
  const active = file.clients.find((c) => c.id === file.active_id);
  if (active) {
    fs.writeFileSync(
      remoteProfilePath(),
      JSON.stringify({ address: active.address, token: active.token }, null, 2) + "\n",
      { mode: 0o600 },
    );
  } else {
    fs.rmSync(remoteProfilePath(), { force: true });
  }
}

/**
 * Guard for IPC handlers that read the client's filesystem or shell out to
 * local tools. When a remote daemon owns the workspaces, every `rootPath` in
 * the UI names a directory on *that* machine, so `existsSync`/`git -C`/`gh`
 * run here answer about the wrong disk. Returning a reason beats failing
 * silently or — worse — reporting a daemon-side path as deleted.
 */
export function remoteHandlerBlock(
  config: RemoteConfig | null,
  action: string,
): { ok: false; error: string } | null {
  if (!config) return null;
  return {
    ok: false,
    error: `${action} needs the files on this machine, but Archductor is connected to the daemon at ${config.address}. Disconnect under Settings → Clients to work with local paths.`,
  };
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

/**
 * Connect over SSH: spawn `ssh <host> archductor archcar stdio-proxy` and use
 * its pipes as the byte stream. No listener and no shared token on the server.
 */
function connectSsh(target: SshTarget): Promise<Duplex> {
  return new Promise((resolve, reject) => {
    const child = spawn("ssh", sshArgs(target), { stdio: ["pipe", "pipe", "pipe"] });
    // ssh reports its own failures here — an unresolvable host, a refused key,
    // a missing archductor on the far side. Without this the caller would only
    // see the stream close.
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", reject);

    const stream = Duplex.from({ readable: child.stdout, writable: child.stdin });
    child.once("exit", (code) => {
      if (code === 0) return;
      const detail = stderr.trim() || `ssh exited with ${code}`;
      stream.destroy(new Error(`ssh transport failed: ${detail}`));
    });
    // Closing the stream has to take the ssh child with it, or every request
    // would leak a process.
    stream.once("close", () => {
      if (child.exitCode === null) child.kill();
    });
    resolve(stream);
  });
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
function lineReader(socket: Duplex, onLine: (line: string) => void): void {
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
  private subSocket: Duplex | null = null;

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
  private async open(): Promise<Duplex> {
    const remote = loadRemoteConfig();
    if (remote?.ssh) return connectSsh(remote.ssh);
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
