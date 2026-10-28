// @vitest-environment node
//
// qa PROBE FILE — not part of PR #219. Round 2, positive half.
//
// Each test asserts the FIXED behaviour, driving the real
// `actions.transferWorkspace` on head 01fba9e. ALL MUST PASS. Paired with
// qa-probe-r2-defects.test.ts, whose four inverted twins must all fail.
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

const REPO_URL = "git@github.com:me/app.git";

function route(
  target: (req: { type: string }) => Promise<never>,
  srcOpts: { transcript?: { role: string; content: string; created_at: string }[] } = {},
) {
  const src = sourceRoute(calls, srcOpts);
  api.requestClient.mockImplementation(async (id: string | null, req: { type: string }) => {
    if (id === "src") return src(req);
    calls.push(`dst:${req.type}`);
    return target(req);
  });
}

const dstCalls = () =>
  api.requestClient.mock.calls.filter((c) => c[0] === "dst").map((c) => c[1] as Record<string, unknown>);
const dstTypes = () => dstCalls().map((c) => c.type as string);

/** Target-side boilerplate every probe needs. */
function targetBase(req: { type: string }) {
  switch (req.type) {
    case "get_remote_access":
      return response({ type: "remote_access", token_path: "/dst/token", token: "d" });
    case "list_repositories":
      return response({ type: "repositories", repositories: [{ name: "app", remote_url: REPO_URL }] });
    default:
      return undefined;
  }
}

describe("qa round-2 probes: the eight round-1 findings on 01fba9e", () => {
  // ── (f) ────────────────────────────────────────────────────────────────────
  it("f FIXED: an archived holder of the branch is refused, and the source is left alone", async () => {
    route(async (req) => {
      const base = targetBase(req);
      if (base) return base;
      switch (req.type) {
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
        default:
          return response({ type: "ack" });
      }
    });
    const { actions } = await import("./actions");
    await expect(actions.transferWorkspace(input)).rejects.toThrow(
      /archived but still holds branch lc\/parser/,
    );
    expect(dstTypes()).not.toContain("import_workspace_from_remote");
    expect(calls).not.toContain("src:archive_workspace");
  });

  // ── (g) ────────────────────────────────────────────────────────────────────
  it("g FIXED: an adopted target with real history but no chat is refused, source left alone", async () => {
    route(async (req) => {
      const base = targetBase(req);
      if (base) return base;
      switch (req.type) {
        case "list_workspaces":
          return response({
            type: "workspaces",
            workspaces: [
              { name: "parser", repository_name: "app", branch: "lc/parser", base_ref: "main", status: "active" },
            ],
          });
        case "get_recent_commits":
          return response({ type: "recent_commits", workspace: "parser", log: `${PUSHED_COMMIT} port it` });
        case "list_chat_threads":
          return response({ type: "chat_threads", workspace: "parser", threads: [] });
        default:
          return response({ type: "ack" });
      }
    });
    const { actions } = await import("./actions");
    await expect(actions.transferWorkspace(input)).rejects.toThrow(/has none of the conversation/);
    expect(calls).not.toContain("src:archive_workspace");
  });

  // ── (b) the CLI's empty-chat wedge, desktop twin ───────────────────────────
  it("b FIXED: an empty source chat gets a thread opened on the target, not a bail", async () => {
    let opened = false;
    let delivered = false;
    route(
      async (req) => {
        const base = targetBase(req);
        if (base) return base;
        switch (req.type) {
          case "list_workspaces":
            return response({
              type: "workspaces",
              workspaces: [
                { name: "parser", repository_name: "app", branch: "lc/parser", base_ref: "main", status: "active" },
              ],
            });
          case "get_recent_commits":
            return response({ type: "recent_commits", workspace: "parser", log: `${PUSHED_COMMIT} port it` });
          case "list_chat_threads":
            return response({ type: "chat_threads", workspace: "parser", threads: [] });
          case "create_chat_thread":
            opened = true;
            return response({ type: "chat_thread_created", thread: { id: 21 } });
          case "queue_chat_input":
            delivered = true;
            return response({ type: "queued_chat_input", thread_id: 21 });
          case "get_chat_snapshot":
            return response({
              type: "chat_snapshot",
              snapshot: {
                thread_id: 21,
                messages: delivered
                  ? [{ role: "user", source: "user_send", content: `${PREAMBLE}src to dst; the branch is at ${PUSHED_COMMIT}.` }]
                  : [],
                events: [],
                provider_events: [],
                queued_inputs: [],
              },
            });
          default:
            return response({ type: "ack" });
        }
      },
      { transcript: [] },
    );
    const { actions } = await import("./actions");
    await expect(actions.transferWorkspace(input)).resolves.toEqual({ workspace: "parser" });
    expect(opened).toBe(true);
    expect(dstTypes()).toContain("ensure_chat_thread_session");
    // The fixed continuation prompt, because there is nothing to replay.
    const queued = dstCalls().find((c) => c.type === "queue_chat_input");
    expect(queued?.input as string).toMatch(/Pick up where you left off/);
    expect(calls).toContain("src:archive_workspace");
  });

  // ── (c) ────────────────────────────────────────────────────────────────────
  it("c FIXED: the second hop starts a session and sends the real ask, not the carried preamble", async () => {
    let imported = false;
    let delivered = false;
    route(
      async (req) => {
        const base = targetBase(req);
        if (base) return base;
        switch (req.type) {
          case "list_workspaces":
            return response({ type: "workspaces", workspaces: [] });
          case "import_workspace_from_remote":
            imported = true;
            return response({
              type: "workspace_imported",
              workspace: "parser",
              repository: "app",
              branch: "lc/parser",
              thread_id: 11,
              copied_messages: 3,
            });
          case "queue_chat_input":
            delivered = true;
            return response({ type: "queued_chat_input", thread_id: 11 });
          case "get_chat_snapshot": {
            const carried = [
              // A→B's preamble, carried as SEEDED history. The old predicate
              // read this as "already handed over" and skipped the hop.
              { role: "user", source: SEEDED, content: `${PREAMBLE}office to src; the branch is at 9999999.` },
              { role: "assistant", source: SEEDED, content: "on it" },
              { role: "user", source: SEEDED, content: "now wire the lexer" },
            ];
            const real = {
              role: "user",
              source: "user_send",
              content: `${PREAMBLE}src to dst; the branch is at ${PUSHED_COMMIT}. Continue from where the transcript leaves off`,
            };
            return response({
              type: "chat_snapshot",
              snapshot: {
                thread_id: 11,
                messages: imported ? (delivered ? [...carried, real] : carried) : [],
                events: [],
                provider_events: [],
                queued_inputs: [],
              },
            });
          }
          default:
            return response({ type: "ack" });
        }
      },
      {
        transcript: [
          { role: "user", content: `${PREAMBLE}office to src; the branch is at 9999999.`, created_at: "1" },
          { role: "assistant", content: "on it", created_at: "2" },
          { role: "user", content: "now wire the lexer", created_at: "3" },
        ],
      },
    );
    const { actions } = await import("./actions");
    await expect(actions.transferWorkspace(input)).resolves.toEqual({ workspace: "parser" });
    expect(dstTypes()).toContain("ensure_chat_thread_session");
    const queued = dstCalls().find((c) => c.type === "queue_chat_input");
    // The real pending ask is replayed under THIS hop's preamble — the carried
    // preamble from the previous hop is not what gets sent on.
    expect(queued?.input as string).toContain("now wire the lexer");
    expect(queued?.input as string).toContain("src to dst");
    expect(calls).toContain("src:archive_workspace");
  });

  // ── (h) ────────────────────────────────────────────────────────────────────
  it("h FIXED: the final archive goes to the pinned source even after a selection switch", async () => {
    const src = sourceRoute(calls);
    let selection = "src";
    let delivered = false;
    api.requestClient.mockImplementation(async (id: string | null, req: { type: string }) => {
      if (id === "src") {
        if (req.type === "push_branch") selection = "other";
        return src(req);
      }
      calls.push(`dst:${req.type}`);
      const base = targetBase(req);
      if (base) return base;
      switch (req.type) {
        case "list_workspaces":
          return response({ type: "workspaces", workspaces: [] });
        case "import_workspace_from_remote":
          return response({
            type: "workspace_imported",
            workspace: "parser",
            repository: "app",
            branch: "lc/parser",
            thread_id: 11,
            copied_messages: 1,
          });
        case "queue_chat_input":
          delivered = true;
          return response({ type: "queued_chat_input", thread_id: 11 });
        case "get_chat_snapshot":
          return response({
            type: "chat_snapshot",
            snapshot: {
              thread_id: 11,
              messages: delivered
                ? [{ role: "user", source: "user_send", content: `${PREAMBLE}src to dst; the branch is at ${PUSHED_COMMIT}.` }]
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
    api.request.mockImplementation(async (req: { type: string }) => {
      calls.push(`${selection}-unpinned:${req.type}`);
      return response({ type: "workspaces", workspaces: [] });
    });
    const { actions } = await import("./actions");
    await expect(actions.transferWorkspace(input)).resolves.toEqual({ workspace: "parser" });
    expect(calls).toContain("src:archive_workspace");
    expect(calls).not.toContain("other-unpinned:archive_workspace");
  });

  // ── (a) the retry identity, by provenance ─────────────────────────────────
  it("a FIXED: a target the daemon renamed on collision is found on retry by its pushed commit", async () => {
    // The first attempt collided on the name, so the daemon versioned BOTH the
    // name and the branch. Neither the requested name nor the requested branch
    // can find it; only the commit it was created at can.
    const renamed = {
      name: "parser-v2",
      repository_name: "app",
      branch: "lc/parser-v2",
      base_ref: "main",
      status: "active",
    };
    route(async (req) => {
      const base = targetBase(req);
      if (base) return base;
      switch (req.type) {
        case "list_workspaces":
          return response({ type: "workspaces", workspaces: [renamed] });
        case "get_recent_commits":
          return response({ type: "recent_commits", workspace: "parser-v2", log: `${PUSHED_COMMIT}def port it` });
        case "list_chat_threads":
          return response({
            type: "chat_threads",
            workspace: "parser-v2",
            threads: [{ id: 31, provider: "codex", title: "Parser port", status: "open", updated_at: "9" }],
          });
        case "get_chat_snapshot":
          // Already handed over by the first attempt.
          return response({
            type: "chat_snapshot",
            snapshot: {
              thread_id: 31,
              messages: [
                { role: "user", source: SEEDED, content: "port it" },
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
    const { actions } = await import("./actions");
    // Adopted, not duplicated: the retry reuses the renamed target…
    await expect(actions.transferWorkspace(input)).resolves.toEqual({ workspace: "parser-v2" });
    expect(dstTypes()).not.toContain("import_workspace_from_remote");
    // …and does not re-send a handover that already landed…
    expect(dstTypes()).not.toContain("queue_chat_input");
    // …but does finish the transfer it left half-done.
    expect(calls).toContain("src:archive_workspace");
  });

  it("a FIXED: a workspace on the same branch in a DIFFERENT repository is not adopted", async () => {
    let delivered = false;
    route(async (req) => {
      switch (req.type) {
        case "get_remote_access":
          return response({ type: "remote_access", token_path: "/dst/token", token: "d" });
        case "list_repositories":
          return response({
            type: "repositories",
            repositories: [
              { name: "app", remote_url: REPO_URL },
              { name: "other", remote_url: "git@github.com:me/other.git" },
            ],
          });
        case "list_workspaces":
          // Same branch name, same workspace-ish shape, unrelated repository.
          return response({
            type: "workspaces",
            workspaces: [
              { name: "parser-elsewhere", repository_name: "other", branch: "lc/parser", base_ref: "main", status: "active" },
            ],
          });
        case "get_recent_commits":
          return response({ type: "recent_commits", workspace: "parser-elsewhere", log: `${PUSHED_COMMIT} port it` });
        case "import_workspace_from_remote":
          return response({
            type: "workspace_imported",
            workspace: "parser",
            repository: "app",
            branch: "lc/parser",
            thread_id: 11,
            copied_messages: 1,
          });
        case "queue_chat_input":
          delivered = true;
          return response({ type: "queued_chat_input", thread_id: 11 });
        case "get_chat_snapshot":
          return response({
            type: "chat_snapshot",
            snapshot: {
              thread_id: 11,
              messages: delivered
                ? [{ role: "user", source: "user_send", content: `${PREAMBLE}src to dst; the branch is at ${PUSHED_COMMIT}.` }]
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
    await actions.transferWorkspace(input);
    // The unrelated repository's workspace was NOT adopted: a real import ran,
    // and the handover went into the imported thread.
    expect(dstTypes()).toContain("import_workspace_from_remote");
    expect(dstTypes()).toContain("queue_chat_input");
  });

  it("a FIXED: a target on our branch at its OWN commit is refused, not duplicated", async () => {
    route(async (req) => {
      const base = targetBase(req);
      if (base) return base;
      switch (req.type) {
        case "list_workspaces":
          return response({
            type: "workspaces",
            workspaces: [
              { name: "parser", repository_name: "app", branch: "lc/parser", base_ref: "main", status: "active" },
            ],
          });
        case "get_recent_commits":
          // That daemon has made its own commits since.
          return response({ type: "recent_commits", workspace: "parser", log: "9f9f9f9 its own work" });
        default:
          return response({ type: "ack" });
      }
    });
    const { actions } = await import("./actions");
    await expect(actions.transferWorkspace(input)).rejects.toThrow(/has its own commits/);
    expect(dstTypes()).not.toContain("import_workspace_from_remote");
    expect(calls).not.toContain("src:archive_workspace");
  });

  // ── (e) ────────────────────────────────────────────────────────────────────
  it("e FIXED: an EMPTY QUEUE with no message row is not delivery, so the source is not archived", async () => {
    route(async (req) => {
      const base = targetBase(req);
      if (base) return base;
      switch (req.type) {
        case "list_workspaces":
          return response({ type: "workspaces", workspaces: [] });
        case "import_workspace_from_remote":
          return response({
            type: "workspace_imported",
            workspace: "parser",
            repository: "app",
            branch: "lc/parser",
            thread_id: 11,
            copied_messages: 1,
          });
        case "queue_chat_input":
          return response({ type: "queued_chat_input", thread_id: 11 });
        case "list_queued_chat_inputs":
          // The row has been CLAIMED: queue empty, nothing delivered yet.
          return response({ type: "queued_chat_inputs", thread_id: 11, inputs: [] });
        case "get_chat_snapshot":
          // No message row ever appears — the session's write failed and the
          // input is being requeued.
          return response({
            type: "chat_snapshot",
            snapshot: {
              thread_id: 11,
              messages: [{ role: "user", source: SEEDED, content: "port it" }],
              events: [],
              provider_events: [],
              queued_inputs: [],
              live_session: { session_id: 5, status: "running", runtime_state: "running" },
            },
          });
        default:
          return response({ type: "ack" });
      }
    });
    const { actions } = await import("./actions");
    const transfer = actions.transferWorkspace(input).catch(() => "rejected");
    const settled = await Promise.race([
      transfer,
      new Promise((resolve) => setTimeout(() => resolve("still-waiting"), 1500)),
    ]);
    // Still waiting on a real message row rather than having taken the empty
    // queue as proof…
    expect(settled).toBe("still-waiting");
    // …and crucially the source has NOT been retired.
    expect(calls).not.toContain("src:archive_workspace");
    expect(dstTypes()).toContain("queue_chat_input");
  });
});
