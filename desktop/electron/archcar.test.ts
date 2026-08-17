import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ArchcarBridge, endpointPath, resolveRemoteConfig } from "./archcar";

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

  it("falls back to temp when XDG_RUNTIME_DIR is absent", () => {
    vi.stubEnv("XDG_STATE_HOME", `/tmp/${"deep/".repeat(30)}state`);
    vi.stubEnv("XDG_RUNTIME_DIR", "");

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
