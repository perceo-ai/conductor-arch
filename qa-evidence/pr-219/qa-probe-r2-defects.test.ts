// @vitest-environment node
//
// qa PROBE FILE — not part of PR #219. Round 2.
//
// These are my four round-1 probes, carried forward and updated only for the
// new `fromDaemon` parameter. Each still asserts the DEFECTIVE behaviour, so
// EVERY TEST HERE MUST NOW FAIL on its behavioural expectation. A pass would
// mean the defect survived.
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import {
  installApi,
  sourceRoute,
  response,
  input,
  PREAMBLE,
  SEEDED,
  PUSHED_COMMIT,
  type MockApi,
} from "./qa-probe-r2-harness";

let api: MockApi;
let calls: string[];

beforeEach(() => {
  vi.resetModules();
  ({ api, calls } = installApi());
});

afterEach(() => {
  delete (globalThis as { window?: unknown }).window;
});

/** Route source and target by the pinned client id. */
function route(target: (req: { type: string }) => Promise<never>, srcOpts = {}) {
  const src = sourceRoute(calls, srcOpts);
  api.requestClient.mockImplementation(async (id: string | null, req: { type: string }) => {
    if (id === "src") return src(req);
    calls.push(`dst:${req.type}`);
    return target(req);
  });
}

const dstTypes = () =>
  api.requestClient.mock.calls
    .filter((c) => c[0] === "dst")
    .map((c) => (c[1] as { type: string }).type);

describe("qa round-1 defect probes, re-run on 01fba9e (all must FAIL)", () => {
  // (f) desktop adopted an ARCHIVED target workspace.
  it("DEFECT f: adopts an archived target, never imports, still archives the source", async () => {
    route(async (req) => {
      switch (req.type) {
        case "get_remote_access":
          return response({ type: "remote_access", token_path: "/dst/token", token: "d" });
        case "list_workspaces":
          return response({
            type: "workspaces",
            workspaces: [
              {
                name: "parser",
                repository_name: "app",
                branch: "lc/parser",
                base_ref: "main",
                status: "archived",
                archived_at: "2026-10-01T00:00:00Z",
              },
            ],
          });
        case "list_repositories":
          return response({
            type: "repositories",
            repositories: [{ name: "app", remote_url: "git@github.com:me/app.git" }],
          });
        case "list_chat_threads":
          return response({ type: "chat_threads", workspace: "parser", threads: [] });
        default:
          return response({ type: "ack" });
      }
    });
    const { actions } = await import("./actions");
    const moved = await actions.transferWorkspace(input);
    expect(moved).toEqual({ workspace: "parser" });
    expect(dstTypes()).not.toContain("import_workspace_from_remote");
    expect(calls).toContain("src:archive_workspace");
  });

  // (g) desktop retired the source when the adopted target had no chat.
  it("DEFECT g: retires the source when the adopted target holds no conversation", async () => {
    route(async (req) => {
      switch (req.type) {
        case "get_remote_access":
          return response({ type: "remote_access", token_path: "/dst/token", token: "d" });
        case "list_workspaces":
          return response({
            type: "workspaces",
            workspaces: [
              { name: "parser", repository_name: "app", branch: "lc/parser", base_ref: "main", status: "active" },
            ],
          });
        case "list_repositories":
          return response({
            type: "repositories",
            repositories: [{ name: "app", remote_url: "git@github.com:me/app.git" }],
          });
        case "get_recent_commits":
          // The adopted target sits at the very commit this transfer pushed.
          return response({ type: "recent_commits", workspace: "parser", log: `${PUSHED_COMMIT} port it` });
        case "list_chat_threads":
          return response({ type: "chat_threads", workspace: "parser", threads: [] });
        default:
          return response({ type: "ack" });
      }
    });
    const { actions } = await import("./actions");
    await actions.transferWorkspace(input);
    expect(dstTypes()).not.toContain("ensure_chat_thread_session");
    expect(calls).toContain("src:archive_workspace");
  });

  // (c) second hop skipped the agent: carried history already held a preamble.
  it("DEFECT c: second hop skips the agent because carried history holds the preamble", async () => {
    let imported = false;
    route(async (req) => {
      switch (req.type) {
        case "get_remote_access":
          return response({ type: "remote_access", token_path: "/dst/token", token: "d" });
        case "list_workspaces":
          return response({ type: "workspaces", workspaces: [] });
        case "list_repositories":
          return response({
            type: "repositories",
            repositories: [{ name: "app", remote_url: "git@github.com:me/app.git" }],
          });
        case "import_workspace_from_remote":
          imported = true;
          return response({
            type: "workspace_imported",
            workspace: "parser",
            repository: "app",
            branch: "lc/parser",
            thread_id: 11,
            copied_messages: 2,
          });
        case "get_chat_snapshot":
          // Exactly what B→C lands with: A→B's preamble, carried as seeded
          // history (source = the fork marker), and nothing else.
          return response({
            type: "chat_snapshot",
            snapshot: {
              thread_id: 11,
              messages: imported
                ? [
                    {
                      role: "user",
                      source: SEEDED,
                      content: `${PREAMBLE}office to src; the branch is at abc1234.`,
                    },
                    { role: "assistant", source: SEEDED, content: "on it" },
                  ]
                : [],
              events: [],
              provider_events: [],
              queued_inputs: [],
            },
          });
        default:
          return response({ type: "ack" });
      }
    });
    const { actions } = await import("./actions");
    // The old code returned success here; the fixed code must at minimum try to
    // start a session, so this call may also reject (the delivery poll never
    // sees a real row in this mock). Either way the assertions below decide.
    await actions.transferWorkspace(input).catch(() => {});
    expect(dstTypes()).not.toContain("ensure_chat_thread_session");
    expect(dstTypes()).not.toContain("queue_chat_input");
  });

  // (h) the source endpoint was re-resolved per request, so a selection change
  // mid-flow redirected the final archive.
  it("DEFECT h: the final archive follows the live selection, not the pinned source", async () => {
    const src = sourceRoute(calls);
    let selection = "src";
    api.requestClient.mockImplementation(async (id: string | null, req: { type: string }) => {
      if (id === "src") {
        if (req.type === "push_branch") selection = "other"; // operator switches daemons
        return src(req);
      }
      calls.push(`dst:${req.type}`);
      switch (req.type) {
        case "get_remote_access":
          return response({ type: "remote_access", token_path: "/dst/token", token: "d" });
        case "list_workspaces":
          return response({ type: "workspaces", workspaces: [] });
        case "list_repositories":
          return response({
            type: "repositories",
            repositories: [{ name: "app", remote_url: "git@github.com:me/app.git" }],
          });
        case "import_workspace_from_remote":
          return response({
            type: "workspace_imported",
            workspace: "parser",
            repository: "app",
            branch: "lc/parser",
            thread_id: 11,
            copied_messages: 1,
          });
        case "get_chat_snapshot":
          return response({
            type: "chat_snapshot",
            snapshot: {
              thread_id: 11,
              messages: [
                { role: "user", source: "user_send", content: `${PREAMBLE}src to dst; the branch is at ${PUSHED_COMMIT}.` },
              ],
              events: [],
              provider_events: [],
              queued_inputs: [],
            },
          });
        default:
          return response({ type: "ack" });
      }
    });
    // The unpinned transport answers as whatever is selected *now*.
    api.request.mockImplementation(async (req: { type: string }) => {
      calls.push(`${selection}-unpinned:${req.type}`);
      return response({ type: "workspaces", workspaces: [] });
    });
    const { actions } = await import("./actions");
    await actions.transferWorkspace(input).catch(() => {});
    expect(calls).toContain("other-unpinned:archive_workspace");
    expect(calls).not.toContain("src:archive_workspace");
  });
});
