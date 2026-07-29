import net from "node:net";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { spawn } from "node:child_process";
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

function stateDir(): string {
  const xdg = process.env.XDG_STATE_HOME;
  const base = xdg && xdg.trim().length > 0 ? xdg : path.join(os.homedir(), ".local/state");
  return path.join(base, "archductor");
}

// UNIX_SOCKET_PATH_LIMIT is ~104-108 bytes; core falls back to a short hashed
// name when the direct path is too long. For dev/typical installs the direct
// path fits. Allow an explicit override to stay in lockstep with core when it
// does hash (ARCHDUCTOR_ARCHCAR_ENDPOINT).
export function endpointPath(): string {
  const override = process.env.ARCHDUCTOR_ARCHCAR_ENDPOINT;
  if (override && override.trim().length > 0) return override;
  const direct = path.join(stateDir(), "archcar.sock");
  if (Buffer.byteLength(direct) < 100) return direct;
  // Long path: core uses archcar-<hash>.sock. We can't reproduce the hash here
  // cheaply; require the override in that case.
  throw new Error(
    `archcar socket path too long (${direct}); set ARCHDUCTOR_ARCHCAR_ENDPOINT to the value core resolved`,
  );
}

function connectOnce(endpoint: string): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(endpoint);
    socket.once("connect", () => resolve(socket));
    socket.once("error", reject);
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

async function ensureDaemon(endpoint: string): Promise<void> {
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
    env: process.env,
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
  private endpoint: string;
  private subSocket: net.Socket | null = null;

  constructor(endpoint = endpointPath()) {
    this.endpoint = endpoint;
  }

  async request<Req, Res>(payload: Req): Promise<Res> {
    await ensureDaemon(this.endpoint);
    const socket = await connectOnce(this.endpoint);
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
    await ensureDaemon(this.endpoint);
    const socket = await connectOnce(this.endpoint);
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
