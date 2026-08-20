import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ArchcarBridge,
  endpointPath,
  remoteHandlerBlock,
  parseClients,
  upsertClient,
  clientIdFrom,
  type ClientsFile,
  resolveRemoteConfig,
} from "./archcar";

// Resolution order for server-hosted execution: environment variables win,
// then the remote profile shared with the CLI, then the local daemon (null).

const none = () => null;

describe("resolveRemoteConfig", () => {
  it("returns null with no environment and no profile", () => {
    expect(resolveRemoteConfig({}, none, none)).toBeNull();
  });

  it("prefers the environment over the profile", () => {
    const config = resolveRemoteConfig(
      { ARCHDUCTOR_ARCHCAR_REMOTE: "devbox:7420", ARCHDUCTOR_ARCHCAR_TOKEN: "env-tok" },
      () => JSON.stringify({ address: "other:1", token: "profile-tok" }),
      none,
    );
    expect(config).toEqual({ address: "devbox:7420", token: "env-tok" });
  });

  it("falls back to the local token file when only the address is in the env", () => {
    const config = resolveRemoteConfig(
      { ARCHDUCTOR_ARCHCAR_REMOTE: "devbox:7420" },
      none,
      () => "file-tok\n",
    );
    expect(config).toEqual({ address: "devbox:7420", token: "file-tok" });
  });

  it("throws when the env names a remote but no token exists anywhere", () => {
    expect(() =>
      resolveRemoteConfig({ ARCHDUCTOR_ARCHCAR_REMOTE: "devbox:7420" }, none, none),
    ).toThrow(/token/);
  });

  it("uses the saved profile when the environment is silent", () => {
    const config = resolveRemoteConfig(
      {},
      () => JSON.stringify({ address: "devbox:7420", token: "profile-tok" }),
      none,
    );
    expect(config).toEqual({ address: "devbox:7420", token: "profile-tok" });
  });

  it("treats malformed or incomplete profiles as absent", () => {
    expect(resolveRemoteConfig({}, () => "not json", none)).toBeNull();
    expect(
      resolveRemoteConfig({}, () => JSON.stringify({ address: " ", token: "x" }), none),
    ).toBeNull();
  });
});

describe("endpointPath", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("prefers an explicit endpoint override", () => {
    vi.stubEnv("ARCHDUCTOR_ARCHCAR_ENDPOINT", "/tmp/custom-archcar.sock");
    expect(endpointPath()).toBe("/tmp/custom-archcar.sock");
  });

  it("uses the core-compatible short socket path when the state path is too long", () => {
    vi.stubEnv("XDG_STATE_HOME", `/tmp/${"deep/".repeat(30)}state`);
    vi.stubEnv("XDG_RUNTIME_DIR", "/tmp/runtime");

    const endpoint = endpointPath();

    expect(endpoint).toMatch(/^\/tmp\/runtime\/archcar-[0-9a-f]{16}\.sock$/);
    expect(Buffer.byteLength(endpoint)).toBeLessThan(100);
  });

  it("matches core when XDG_RUNTIME_DIR is empty", () => {
    vi.stubEnv("XDG_STATE_HOME", `/tmp/${"deep/".repeat(30)}state`);
    vi.stubEnv("XDG_RUNTIME_DIR", "");

    expect(endpointPath()).toMatch(/^archcar-[0-9a-f]{16}\.sock$/);
  });

  it("falls back to temp when XDG_RUNTIME_DIR is absent", () => {
    vi.stubEnv("XDG_STATE_HOME", `/tmp/${"deep/".repeat(30)}state`);
    vi.unstubAllEnvs();
    vi.stubEnv("XDG_STATE_HOME", `/tmp/${"deep/".repeat(30)}state`);

    expect(endpointPath()).toMatch(
      new RegExp(`^${escapeRegExp(path.join(os.tmpdir(), "archductor"))}/archcar-[0-9a-f]{16}\\.sock$`),
    );
  });
});

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

describe("ArchcarBridge remote transport", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("sends the token line before the request and never spawns a sidecar", async () => {
    // Fake daemon: expect "<token>\n" then one envelope line, answer it.
    const seen: string[] = [];
    const server = net.createServer((socket) => {
      let buf = "";
      socket.setEncoding("utf8");
      socket.on("data", (chunk: string) => {
        buf += chunk;
        let idx: number;
        while ((idx = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, idx);
          buf = buf.slice(idx + 1);
          seen.push(line);
          if (seen.length === 2) {
            const envelope = JSON.parse(line) as { id: string };
            socket.write(
              JSON.stringify({ id: envelope.id, payload: { type: "ack" } }) + "\n",
            );
          }
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as net.AddressInfo).port;

    vi.stubEnv("ARCHDUCTOR_ARCHCAR_REMOTE", `127.0.0.1:${port}`);
    vi.stubEnv("ARCHDUCTOR_ARCHCAR_TOKEN", "test-token");

    const bridge = new ArchcarBridge();
    const res = await bridge.request<{ type: string }, { type: string }>({ type: "doctor" });

    expect(res).toEqual({ type: "ack" });
    expect(seen[0]).toBe("test-token");
    expect(JSON.parse(seen[1]).payload).toEqual({ type: "doctor" });

    server.close();
  });
});

// Client-filesystem handlers must refuse while a remote daemon owns the
// workspaces: the paths in the UI belong to the daemon's machine, not this one.

describe("remoteHandlerBlock", () => {
  it("allows the handler through when no remote is configured", () => {
    expect(remoteHandlerBlock(null, "Opening the folder")).toBeNull();
  });

  it("blocks with the action, the address, and the way back", () => {
    const block = remoteHandlerBlock(
      { address: "devbox:7420", token: "tok" },
      "Opening the folder",
    );
    expect(block?.ok).toBe(false);
    expect(block?.error).toContain("Opening the folder");
    expect(block?.error).toContain("devbox:7420");
    expect(block?.error).toContain("Settings");
  });

  it("never leaks the token into the message shown to the user", () => {
    const block = remoteHandlerBlock({ address: "devbox:7420", token: "s3cret" }, "Opening");
    expect(block?.error).not.toContain("s3cret");
  });
});

// The saved-client list mirrors crates/core/src/archcar/remote.rs. `clients.json`
// is the list, `remote.json` is the selection, and these two files must agree
// with the Rust side or the CLI and the app will disagree about where requests go.

describe("parseClients", () => {
  it("returns an empty list with no files", () => {
    expect(parseClients(null, null)).toEqual({ clients: [] });
  });

  it("adopts a pre-existing single profile so upgrading keeps the connection", () => {
    const file = parseClients(null, JSON.stringify({ address: "devbox:7420", token: "tok" }));
    expect(file.clients).toEqual([
      { id: "devbox-7420", label: "devbox:7420", address: "devbox:7420", token: "tok" },
    ]);
    expect(file.active_id).toBe("devbox-7420");
  });

  it("ignores the old profile once real clients exist", () => {
    const raw = JSON.stringify({
      active_id: "a",
      clients: [{ id: "a", label: "A", address: "a:1", token: "t" }],
    });
    const file = parseClients(raw, JSON.stringify({ address: "old:1", token: "old" }));
    expect(file.clients).toHaveLength(1);
    expect(file.clients[0].address).toBe("a:1");
  });

  it("drops incomplete clients and forgets an active id with no match", () => {
    const raw = JSON.stringify({
      active_id: "ghost",
      clients: [
        { id: "a", label: "A", address: "", token: "t" },
        { id: "b", label: "B", address: "b:1", token: "  " },
        { id: "c", label: "C", address: "c:1", token: "t" },
      ],
    });
    const file = parseClients(raw, null);
    expect(file.clients.map((c) => c.id)).toEqual(["c"]);
    expect(file.active_id).toBeUndefined();
  });

  it("falls back to the local daemon on a malformed list rather than throwing", () => {
    expect(parseClients("not json", null)).toEqual({ clients: [] });
  });
});

describe("upsertClient", () => {
  it("refreshes a known address instead of duplicating it", () => {
    const file: ClientsFile = { clients: [] };
    const first = upsertClient(file, "Devbox", "devbox:7420", "old");
    const again = upsertClient(file, undefined, "devbox:7420", "new");

    expect(again).toBe(first);
    expect(file.clients).toHaveLength(1);
    expect(file.clients[0].token).toBe("new");
    expect(file.clients[0].label).toBe("Devbox");
  });

  it("slugifies labels and keeps ids unique, matching the Rust slug rules", () => {
    const file: ClientsFile = { clients: [] };
    upsertClient(file, "My Devbox!", "a:1", "t");
    upsertClient(file, "My Devbox!", "b:2", "t");
    upsertClient(file, "  ", "c:3", "t");

    expect(file.clients.map((c) => c.id)).toEqual(["my-devbox", "my-devbox-2", "c-3"]);
    expect(file.clients[2].label).toBe("c:3");
  });
});

describe("clientIdFrom", () => {
  it("matches the Rust slug for the shapes we generate ids from", () => {
    expect(clientIdFrom("Devbox")).toBe("devbox");
    expect(clientIdFrom("devbox:7420")).toBe("devbox-7420");
    expect(clientIdFrom("My Devbox!")).toBe("my-devbox");
    expect(clientIdFrom("!!!")).toBe("client");
  });
});
