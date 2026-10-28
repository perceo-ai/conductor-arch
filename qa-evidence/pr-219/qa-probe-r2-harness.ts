// qa PROBE HARNESS — not part of PR #219.
//
// Shared mock-daemon rig for the round-2 re-review probes. Both ends are saved
// clients, so every source call lands on `requestClient("src", …)` and every
// target call on `requestClient("dst", …)`; `request` is the *unpinned* `send()`
// transport, which after this PR no part of the transfer may use for the source.
import { vi } from "vitest";

export interface MockApi {
  request: ReturnType<typeof vi.fn>;
  requestLocal: ReturnType<typeof vi.fn>;
  requestClient: ReturnType<typeof vi.fn>;
  ensureEvents: ReturnType<typeof vi.fn>;
  onEvent: ReturnType<typeof vi.fn>;
  onWindowFocus: ReturnType<typeof vi.fn>;
  window: { minimize: () => void; toggleMaximize: () => void; close: () => void };
  log: ReturnType<typeof vi.fn>;
}

export const PREAMBLE = "This conversation moved from daemon ";
export const SEEDED = "fork";
export const PUSHED_COMMIT = "abc1234";

export const sourceWorkspace = {
  name: "parser",
  repository_name: "app",
  branch: "lc/parser",
  base_ref: "main",
  status: "active",
};

/** `--from src --to dst`, both saved clients, source pinned by the caller. */
export const input = {
  workspace: "parser",
  toClientId: "dst",
  toLabel: "dst",
  fromLabel: "src",
  fromDaemon: { kind: "client", clientId: "src" } as const,
};

export function response(payload: unknown) {
  return payload as never;
}

export function installApi(): { api: MockApi; calls: string[] } {
  const calls: string[] = [];
  const api: MockApi = {
    request: vi.fn(async (req: { type: string }) => {
      calls.push(`UNPINNED:${req.type}`);
      return response({ type: "workspaces", workspaces: [] });
    }),
    requestLocal: vi.fn(async (req: { type: string }) => {
      calls.push(`local:${req.type}`);
      return response({ type: "ack" });
    }),
    requestClient: vi.fn(async () => response({ type: "ack" })),
    ensureEvents: vi.fn(async () => ({ ok: true })),
    onEvent: vi.fn(() => () => {}),
    onWindowFocus: vi.fn(() => () => {}),
    window: { minimize: () => {}, toggleMaximize: () => {}, close: () => {} },
    log: vi.fn(),
  };
  (globalThis as unknown as { window: { archductor: MockApi } }).window = { archductor: api };
  return { api, calls };
}

/** An idle source daemon holding `parser` with one chat that has history. */
export function sourceRoute(
  calls: string[],
  opts: { transcript?: { role: string; content: string; created_at: string }[] } = {},
) {
  const transcript = opts.transcript ?? [{ role: "user", content: "port it", created_at: "1" }];
  return async (req: { type: string }) => {
    calls.push(`src:${req.type}`);
    switch (req.type) {
      case "get_remote_access":
        return response({ type: "remote_access", token_path: "/src/token", token: "s" });
      case "list_workspaces":
        return response({ type: "workspaces", workspaces: [sourceWorkspace] });
      case "list_repositories":
        return response({
          type: "repositories",
          repositories: [{ name: "app", remote_url: "git@github.com:me/app.git" }],
        });
      case "list_chat_threads":
        return response({
          type: "chat_threads",
          workspace: "parser",
          threads: [
            { id: 7, provider: "codex", title: "Parser port", status: "open", updated_at: "9" },
          ],
        });
      case "get_chat_snapshot":
        return response({
          type: "chat_snapshot",
          snapshot: {
            thread_id: 7,
            messages: [],
            events: [],
            provider_events: [],
            queued_inputs: [],
            live_session: undefined,
          },
        });
      case "get_chat_transcript":
        return response({
          type: "chat_transcript",
          thread_id: 7,
          title: "Parser port",
          messages: transcript,
        });
      case "get_workspace_changes":
        return response({ type: "workspace_changes", workspace: "parser", files: [] });
      case "get_recent_commits":
        return response({ type: "recent_commits", workspace: "parser", log: `${PUSHED_COMMIT} port it` });
      default:
        return response({ type: "ack" });
    }
  };
}
