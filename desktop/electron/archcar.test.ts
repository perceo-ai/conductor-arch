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
  parseSshAddress,
  isSshAddress,
  sshArgs,
} from "./archcar";

// Resolution order for server-hosted execution: environment variables win,
// then the remote profile shared with the CLI, then the local daemon (null).

const none = () => null;

// Mirrors the Rust tests in crates/core/src/archcar/remote.rs. The two parsers
// read the same saved profile, so a disagreement would send the app and the CLI
// to different daemons.
describe("ssh addresses", () => {
  it("parses user, host, port, and an explicit program", () => {
    expect(parseSshAddress("ssh://deploy@build.internal:2222/opt/bin/archductor")).toEqual({
      destination: "deploy@build.internal",
      port: 2222,
      program: "/opt/bin/archductor",
    });
    expect(parseSshAddress("ssh://devbox")).toEqual({
      destination: "devbox",
      port: null,
      program: "archductor",
    });
  });

  it("does not mistake an IPv6 literal for a port", () => {
    expect(parseSshAddress("ssh://[fe80::1]")).toEqual({
      destination: "[fe80::1]",
      port: null,
      program: "archductor",
    });
  });

  it("leaves a host:port address to the TCP transport", () => {
    expect(parseSshAddress("devbox:7420")).toBeNull();
    expect(isSshAddress("devbox:7420")).toBe(false);
    expect(isSshAddress("  ssh://devbox  ")).toBe(true);
  });

  it("throws on a malformed ssh address rather than falling back", () => {
    // Falling through to TCP would demand a token the user never supplied.
    expect(() => parseSshAddress("ssh://")).toThrow(/host/);
    expect(() => parseSshAddress("ssh://host:notaport")).toThrow(/port/);
  });

  it("builds ssh args that disable the pty and prompts", () => {
    const args = sshArgs({ destination: "deploy@host", port: 2222, program: "archductor" });

    expect(args).toContain("-T");
    expect(args).toContain("BatchMode=yes");
    expect(args).toContain("2222");
    expect(args.slice(-5)).toEqual([
      "deploy@host",
      "archductor",
      "archcar",
      "stdio-proxy",
      "--quiet",
    ]);
  });
});

describe("resolveRemoteConfig", () => {
  it("resolves an ssh:// profile with no token", () => {
    // Only the TCP transport needs a token, so a blank one here is complete
    // rather than half-written.
    const config = resolveRemoteConfig(
      {},
      () => JSON.stringify({ address: "ssh://deploy@host", token: "" }),
      none,
    );

    expect(config?.address).toBe("ssh://deploy@host");
    expect(config?.ssh).toEqual({
      destination: "deploy@host",
      port: null,
      program: "archductor",
    });
  });

  it("keeps ssh clients in the saved list even though they have no token", () => {
    // Requiring a token here dropped ssh clients, so the switcher showed
    // "This machine" while every request went to the remote daemon.
    const file = parseClients(
      JSON.stringify({
        active_id: "ssh-root-192-168-68-110",
        clients: [
          { id: "ssh-root-192-168-68-110", label: "perceo-control", address: "ssh://root@192.168.68.110", token: "" },
          { id: "tcp-box", label: "tcp box", address: "box:7420", token: "tok" },
          { id: "broken", label: "broken", address: "other:7420", token: "" },
        ],
      }),
      null,
    );

    expect(file.clients.map((c) => c.id)).toEqual(["ssh-root-192-168-68-110", "tcp-box"]);
    expect(file.active_id).toBe("ssh-root-192-168-68-110");
  });

  it("adopts a tokenless ssh profile when no client list exists", () => {
    const file = parseClients(null, JSON.stringify({ address: "ssh://deploy@host", token: "" }));

    expect(file.clients).toHaveLength(1);
    expect(file.clients[0]?.address).toBe("ssh://deploy@host");
    expect(file.active_id).toBe(file.clients[0]?.id);
  });

  it("resolves an ssh:// address from the environment without a token", () => {
    const config = resolveRemoteConfig({ ARCHDUCTOR_ARCHCAR_REMOTE: "ssh://devbox" }, none, none);

    expect(config?.ssh?.destination).toBe("devbox");
    expect(config?.token).toBe("");
  });
});

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
