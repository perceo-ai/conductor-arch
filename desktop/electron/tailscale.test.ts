import net from "node:net";
import { describe, expect, it } from "vitest";

import { addressHost, AUTH_FAILURE_MARKER, parseStatus, probeArchcar, suggest } from "./tailscale";

// Same fixture and cases as crates/core/src/archcar/tailscale.rs, so the two
// discovery implementations cannot drift apart unnoticed.
const STATUS = JSON.stringify({
  BackendState: "Running",
  Self: { HostName: "laptop", Online: true, TailscaleIPs: ["100.64.0.1"] },
  Peer: {
    "nodekey:a": {
      HostName: "devbox",
      DNSName: "devbox.tail1.ts.net.",
      OS: "linux",
      TailscaleIPs: ["fd7a::2", "100.64.0.2"],
      Online: true,
      sshHostKeys: ["ssh-ed25519 AAAA"],
    },
    "nodekey:b": {
      HostName: "Builder",
      DNSName: "builder.tail1.ts.net.",
      OS: "linux",
      TailscaleIPs: ["100.64.0.3"],
      Online: true,
    },
    "nodekey:c": { HostName: "phone", OS: "iOS", TailscaleIPs: ["100.64.0.4"], Online: true },
    "nodekey:d": { HostName: "asleep", OS: "linux", TailscaleIPs: ["100.64.0.5"], Online: false },
  },
});

describe("tailscale discovery", () => {
  it("keeps online non-mobile peers, sorted", () => {
    expect(parseStatus(STATUS).map((p) => p.HostName)).toEqual(["Builder", "devbox"]);
  });

  it("refuses a stopped tailnet", () => {
    expect(() => parseStatus(JSON.stringify({ BackendState: "Stopped" }))).toThrow(/not connected/);
  });

  it("prefers ssh and marks tcp as needing a token", () => {
    const [builder, devbox] = parseStatus(STATUS);
    const ssh = suggest(devbox, true, 7420, [])!;
    expect(ssh.transport).toBe("ssh");
    expect(ssh.suggested_address).toBe("ssh://devbox.tail1.ts.net");
    expect(ssh.needs_token).toBe(false);
    expect(ssh.ip).toBe("100.64.0.2");

    const tcp = suggest(builder, true, 7420, [])!;
    expect(tcp.transport).toBe("tcp");
    expect(tcp.suggested_address).toBe("builder.tail1.ts.net:7420");
    expect(tcp.needs_token).toBe(true);

    expect(suggest(builder, false, 7420, [])).toBeNull();
  });

  it("matches a saved client by any name form", () => {
    const devbox = parseStatus(STATUS)[1];
    for (const saved of [
      "ssh://me@devbox.tail1.ts.net:22/opt/archductor",
      "100.64.0.2:7420",
      "DEVBOX:7420",
      "devbox.tail1.ts.net.:7420",
    ]) {
      expect(suggest(devbox, false, 7420, [saved])!.saved).toBe(true);
    }
    expect(suggest(devbox, false, 7420, ["builder:7420"])!.saved).toBe(false);
  });

  it("strips every decoration from an address", () => {
    expect(addressHost("ssh://u@h.example:2222/bin/a")).toBe("h.example");
    expect(addressHost("h:7420")).toBe("h");
    expect(addressHost("[fd7a::2]:7420")).toBe("fd7a::2");
    expect(addressHost("plainhost")).toBe("plainhost");
  });

  it("recognises an archcar rejection and nothing else", async () => {
    const serve = (reply: string) =>
      new Promise<net.Server>((resolve) => {
        const server = net.createServer((socket) => {
          socket.once("data", () => socket.end(reply));
        });
        server.listen(0, "127.0.0.1", () => resolve(server));
      });
    const port = (s: net.Server) => (s.address() as net.AddressInfo).port;

    const archcar = await serve(`{"id":"auth","payload":{"type":"error","message":"${AUTH_FAILURE_MARKER}"}}\n`);
    const other = await serve("SSH-2.0-OpenSSH_9.9\r\n");
    try {
      expect(await probeArchcar("127.0.0.1", port(archcar))).toBe(true);
      expect(await probeArchcar("127.0.0.1", port(other))).toBe(false);
    } finally {
      archcar.close();
      other.close();
    }
    const closed = await serve("");
    const closedPort = port(closed);
    await new Promise((r) => closed.close(r));
    expect(await probeArchcar("127.0.0.1", closedPort, 300)).toBe(false);
  });
});
