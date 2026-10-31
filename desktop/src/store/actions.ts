// State-changing archcar actions (parity with the in-process GTK flows).
//
// Every action is logged before it runs and the resulting inventory refresh is
// logged after. archcar has no "inventory changed" event, so — like the GTK
// sidebar's post-mutation refresh — the caller re-pulls the workspace and
// repository lists once the mutation acks.

import { send, sendLocal, sendToClient, sendToDaemon, type SelectedDaemon } from "@/bridge/client";
import { logAction, logState } from "@/lib/log";
import type {
  AppliedDaemonUpdate,
  ArchcarRequest,
  ArchcarResponse,
  DaemonUpdateStatus,
} from "@/bridge/protocol";
import { workspacesStore } from "./workspaces";
import { repositoriesStore } from "./repositories";
import { nav } from "./nav";
import { layoutStore } from "./layout";
import { visiblePanelIds, type PanelId } from "@/lib/layout";
import { panelDescriptor } from "@/lib/panelRegistry";

async function refreshInventory(): Promise<void> {
  await Promise.all([workspacesStore.refresh(), repositoriesStore.refresh()]);
  logState("inventory refreshed", {
    workspaces: workspacesStore.state.order.length,
    repositories: repositoriesStore.state.order.length,
  });
}

/** Throw on an archcar error response so callers surface it to the user. */
function ensureOk(res: ArchcarResponse): ArchcarResponse {
  if (res.type === "error") throw new Error(res.message);
  return res;
}

/**
 * This machine has no clone of the repository a remote workspace belongs to.
 * Choosing where to clone it is the user's call, so the caller asks and retries
 * with `cloneInto`.
 */
export class MissingLocalRepositoryError extends Error {
  constructor(
    readonly repositoryUrl: string,
    readonly repositoryName: string,
  ) {
    super(`this machine has no clone of ${repositoryUrl}`);
  }
}

/**
 * A transfer was refused because the source still has a live agent. Distinct
 * from a generic failure so the caller can offer "stop it and transfer anyway"
 * rather than only reporting the refusal.
 */
export class LiveSourceSessionError extends Error {}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type ArchcarSender = (req: ArchcarRequest) => Promise<ArchcarResponse>;

async function commitSourceChangesIfNeeded(
  sender: ArchcarSender,
  workspace: string,
  message: string,
): Promise<void> {
  const changes = ensureOk(
    await sender({ type: "get_workspace_changes", workspace, scope: "uncommitted" }),
  );
  const visibleChanges = changes.type === "workspace_changes" ? changes.files.length : 0;
  const committed = await sender({
    type: "commit_workspace_changes",
    workspace,
    message,
    stage_all: true,
  });
  if (
    visibleChanges === 0 &&
    committed.type === "error" &&
    committed.message === "stage at least one file before committing"
  ) {
    return;
  }
  ensureOk(committed);
}

/** Session states that mean the agent is no longer running. */
const TERMINAL_SESSION_STATES = new Set(["interrupted", "failed", "exited", "archived"]);

/** Opens the message a transfer hands its resumed session, so it doubles as the
 * marker that a chat has already been handed over. */
const TRANSFER_PREAMBLE_PREFIX = "This conversation moved from daemon ";

/**
 * Whether a transfer message was actually *delivered to a session* for this
 * chat, rather than merely queued or merely present in carried history.
 *
 * Seeded rows are excluded. `seed_imported_chat` copies a carried transcript
 * verbatim, so a workspace moved A→B arrives at C with B's preamble already in
 * its history; counting that as "already resumed" skipped the second hop of a
 * chain entirely while still archiving B. Seeded rows carry the fork source,
 * and only a row the session itself appended after a successful write has any
 * other source. Mirrors `transfer_message_delivered` in crates/cli/src/main.rs.
 */
function hasDeliveredTransferMessage(messages: { role: string; content: string; source: string }[]): boolean {
  return messages.some(
    (message) =>
      message.role === "user" &&
      message.source !== SEEDED_MESSAGE_SOURCE &&
      message.content.startsWith(TRANSFER_PREAMBLE_PREFIX),
  );
}

/** `FORKED_MESSAGE_SOURCE` in crates/core/src/workspace.rs: the source a
 * carried/seeded transcript row is written with. */
const SEEDED_MESSAGE_SOURCE = "fork";

/** The `owner/repo` tail of a git remote URL, lowercased and without `.git`, so
 * the `git@host:`, `https://host/` and `ssh://host:22/` forms of one repository
 * compare equal. Mirrors `repository_url_tail` in crates/cli/src/main.rs. */
export function repositoryUrlTail(url: string): string {
  let path = url.trim().replace(/\/+$/, "");
  path = path.replace(/\.git$/, "");
  const scheme = path.indexOf("://");
  if (scheme >= 0) path = path.slice(scheme + 3);
  const colon = path.indexOf(":");
  if (colon >= 0) path = path.slice(colon + 1);
  const segments = path.split("/").filter((part) => part.length > 0);
  return segments.slice(Math.max(0, segments.length - 2)).join("/").toLowerCase();
}

/** Two abbreviated shas naming one commit; `get_recent_commits` abbreviates, so
 * neither width is fixed. Mirrors `commits_match` in crates/cli/src/main.rs. */
export function commitsMatch(left?: string, right?: string): boolean {
  const a = (left ?? "").trim().toLowerCase();
  const b = (right ?? "").trim().toLowerCase();
  const shared = Math.min(a.length, b.length);
  if (shared < 7) return false;
  if (!/^[0-9a-f]+$/.test(a) || !/^[0-9a-f]+$/.test(b)) return false;
  return a.slice(0, shared) === b.slice(0, shared);
}

/**
 * What a daemon says it is, for telling two ends of a transfer apart.
 *
 * `get_remote_access` answers out of the *serving* daemon's own paths, so its
 * token path and token are properties of that daemon and come back identical
 * however it was reached. Configured addresses cannot do this: one daemon has
 * as many of those as there are names for it. Only ever compared, never shown —
 * the token is a credential. Mirrors `transfer_daemon_identity` in
 * crates/cli/src/main.rs.
 */
async function daemonIdentity(
  transport: (req: ArchcarRequest) => Promise<ArchcarResponse>,
): Promise<string | undefined> {
  try {
    const res = await transport({ type: "get_remote_access" });
    if (res.type !== "remote_access") return undefined;
    return `${res.token_path}\n${res.token}`;
  } catch {
    // A daemon too old to answer. Unknown, not "different".
    return undefined;
  }
}

/**
 * The chat in an adopted workspace that actually holds the transferred
 * conversation.
 *
 * Adoption proves the *workspace* is this transfer's (same repository, branch
 * and commit) but says nothing about which chat in it is the imported one, and
 * an operator who opened their own chat there after an interrupted transfer
 * would have the handover delivered into that instead. So it is identified, in
 * order of evidence: a chat this transfer has already handed over, then one
 * carrying seeded history, then the most recently touched. Mirrors
 * `target_thread_for` in crates/cli/src/main.rs.
 */
async function importedThreadIn(
  transport: (req: ArchcarRequest) => Promise<ArchcarResponse>,
  workspace: string,
): Promise<number | undefined> {
  const listed = await transport({ type: "list_chat_threads", workspace });
  if (listed.type !== "chat_threads") return undefined;
  const live = [...listed.threads]
    .filter((thread) => !thread.archived_at)
    .sort((a, b) => Number(b.updated_at) - Number(a.updated_at));
  let seeded: number | undefined;
  for (const thread of live) {
    const snapshot = await transport({
      type: "get_chat_snapshot",
      thread_id: thread.id,
      include_provider_events: false,
    });
    if (snapshot.type !== "chat_snapshot") continue;
    if (hasDeliveredTransferMessage(snapshot.snapshot.messages)) return thread.id;
    if (
      seeded === undefined &&
      snapshot.snapshot.messages.some((message) => message.source === SEEDED_MESSAGE_SOURCE)
    ) {
      seeded = thread.id;
    }
  }
  return seeded ?? live[0]?.id;
}

const TRANSFER_POLL_INTERVAL_MS = 250;
const TRANSFER_POLL_TIMEOUT_MS = 60_000;

/**
 * Wait until the source daemon agrees a session it was asked to kill is gone.
 *
 * An error response counts as gone: the daemon cannot reach it either, and the
 * id came from a snapshot taken moments ago, so it is not a session still
 * being spawned.
 */
async function waitForSessionGone(daemon: SelectedDaemon, sessionId: number): Promise<void> {
  const deadline = Date.now() + TRANSFER_POLL_TIMEOUT_MS;
  for (;;) {
    const status = await sendToDaemon(daemon, {
      type: "get_session_status",
      session_id: sessionId,
    });
    if (status.type === "error") return;
    if (
      status.type === "session_status" &&
      (status.status !== "running" || TERMINAL_SESSION_STATES.has(status.runtime_state))
    ) {
      return;
    }
    if (Date.now() >= deadline) {
      throw new Error(`session ${sessionId} did not stop in time; nothing has been pushed`);
    }
    await sleep(TRANSFER_POLL_INTERVAL_MS);
  }
}

/**
 * The one message the resumed session is handed.
 *
 * The transcript itself is already seeded on the target and replayed to the
 * agent on its first turn, so this only says what moved and what to do next.
 * Which form it takes is decided by the transcript's last message, not by
 * whether the agent was mid-turn: ending on the user means there is a pending
 * ask to replay verbatim under the preamble, and ending on the agent (or an
 * empty transcript) means there is nothing to replay and a fixed continuation
 * prompt is sent instead. Keyed off the role so the same transcript always
 * produces the same message. Mirrors `transfer_resume_message` in
 * crates/cli/src/main.rs.
 */
export function transferResumeMessage(
  transcript: { role: string; content: string }[],
  fromLabel: string,
  toLabel: string,
  commit?: string,
): string {
  const branchState = commit?.trim()
    ? `the branch is at ${commit.trim().slice(0, 12)}`
    : "the branch has been pushed";
  const preamble = `${TRANSFER_PREAMBLE_PREFIX}${fromLabel} to ${toLabel}; ${branchState}.`;
  const last = transcript[transcript.length - 1];
  if (last?.role === "user") {
    return `${preamble} Continue from where the transcript leaves off \u2014 do not redo completed work.\n\n${last.content.trim()}`;
  }
  return `${preamble} Pick up where you left off and continue the work \u2014 do not redo anything already done.`;
}

/**
 * Start a session on the target and hand it the conversation.
 *
 * Session first, then the message, which is the order the chat path already
 * uses: the queue drains into a session that is coming up. Returns only once
 * the queue has drained, i.e. the message actually reached the provider —
 * archiving the source depends on that.
 */
async function resumeTransferredChat(input: {
  toClientId: string | null;
  toLabel: string;
  workspace: string;
  threadId: number;
  provider: string;
  transcript: { role: string; content: string }[];
  commit?: string;
  fromLabel: string;
}): Promise<void> {
  const sendTarget = (req: ArchcarRequest) => sendToClient(input.toClientId, req);
  const snapshot = await sendTarget({
    type: "get_chat_snapshot",
    thread_id: input.threadId,
    include_provider_events: false,
  });
  if (snapshot.type === "chat_snapshot" && hasDeliveredTransferMessage(snapshot.snapshot.messages)) {
    // Already handed over by an earlier attempt. Re-sending would tell the
    // agent to continue work it has since finished.
    return;
  }
  if (input.provider === "shell") {
    throw new Error(
      `the chat moved with ${input.workspace} runs under shell, which has no turns to resume; the workspace is on ${input.toLabel} and its branch is pushed, but start a session there yourself`,
    );
  }
  const kind = input.provider as "codex" | "claude";
  ensureOk(
    await sendTarget({
      type: "ensure_chat_thread_session",
      workspace: input.workspace,
      thread_id: input.threadId,
      kind,
    }),
  );
  const message = transferResumeMessage(
    input.transcript,
    input.fromLabel,
    input.toLabel,
    input.commit,
  );
  ensureOk(
    await sendTarget({
      type: "queue_chat_input",
      thread_id: input.threadId,
      input: message,
      visible_input: message,
      kind: "user",
      session_kind: kind,
      // The preamble is operator text and must reach the agent as written.
      verbatim: true,
    }),
  );
  // Delivery is confirmed from the thread's own messages, never from an empty
  // queue: `claim_next_queued_chat_input` is a `DELETE ... RETURNING`, so the
  // row leaves the queue before the session writes the line and is put back if
  // that write fails. An empty queue means "claimed", not "delivered".
  const deadline = Date.now() + TRANSFER_POLL_TIMEOUT_MS;
  for (;;) {
    const current = await sendTarget({
      type: "get_chat_snapshot",
      thread_id: input.threadId,
      include_provider_events: false,
    });
    if (current.type === "error") throw new Error(current.message);
    if (
      current.type === "chat_snapshot" &&
      hasDeliveredTransferMessage(current.snapshot.messages)
    ) {
      return;
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `the conversation was queued for ${input.workspace} on ${input.toLabel} but no session there had taken it in time; the source workspace has been left alone`,
      );
    }
    await sleep(TRANSFER_POLL_INTERVAL_MS);
  }
}

export interface AddRepositoryInput {
  path: string;
  name?: string;
  remoteName?: string;
  defaultBranch?: string;
}

export interface CreateWorkspaceInput {
  repository: string;
  name: string;
  branch: string;
  baseRef?: string;
}

/** `send` follows the client switcher; `sendLocal` is always this machine. */
type Transport = typeof send;

async function daemonUpdateStatus(transport: Transport = send): Promise<DaemonUpdateStatus> {
  const res = ensureOk(await transport({ type: "get_update_status" }));
  if (res.type !== "update_status") throw new Error("the daemon did not report its version");
  return res.status;
}

export const actions = {
  /** Re-pull workspaces + repositories (archcar has no inventory-changed event). */
  refreshInventory,

  daemonUpdateStatus,

  /**
   * Update the connected daemon — this machine's or a remote one — and wait
   * for it to come back on the new version. The daemon restarts itself after
   * answering, so requests fail for a moment; those failures are the restart,
   * not an error.
   */
  async updateDaemon(
    options: {
      force?: boolean;
      pollMs?: number;
      timeoutMs?: number;
      transport?: Transport;
      /** False once the user switched to another daemon mid-update. */
      stillTargeted?: () => boolean;
    } = {},
  ): Promise<AppliedDaemonUpdate> {
    logAction("apply_update", { force: options.force ?? false });
    const transport = options.transport ?? send;
    const res = ensureOk(await transport({ type: "apply_update", force: options.force }));
    if (res.type !== "update_applied") throw new Error("the daemon did not apply an update");
    const pollMs = options.pollMs ?? 1000;
    const deadline = Date.now() + (options.timeoutMs ?? 60_000);
    await sleep(pollMs * 2);
    while (Date.now() < deadline) {
      try {
        if (options.stillTargeted && !options.stillTargeted()) {
          // Polls would now reach a different daemon and time out wrongly.
          throw new Error(
            `switched daemons during the update; v${res.update.to_version} was being installed on the previous one`,
          );
        }
        if ((await daemonUpdateStatus(transport)).current_version === res.update.to_version) {
          await refreshInventory();
          return res.update;
        }
      } catch (err) {
        if (err instanceof Error && err.message.startsWith("switched daemons")) throw err;
        // Still restarting.
      }
      await sleep(pollMs);
    }
    throw new Error(
      `the daemon did not come back on v${res.update.to_version} within a minute; check its service`,
    );
  },

  async setDaemonAutoUpdate(enabled: boolean): Promise<DaemonUpdateStatus> {
    logAction("set_auto_update", { enabled });
    const res = ensureOk(await send({ type: "set_auto_update", enabled }));
    if (res.type !== "update_status") throw new Error("the daemon did not confirm the setting");
    return res.status;
  },

  /**
   * The app updates itself, and with it the daemon binary it bundles — but a
   * daemon kept alive by launchd keeps running the old one. On launch, move
   * this machine's bundled daemon onto the binary the app just installed.
   * Never forced: agents mid-turn win, and the next launch tries again.
   */
  async finishBundledDaemonUpdate(pollMs?: number): Promise<boolean> {
    // Always this machine's daemon, whichever client is selected: the app's
    // own bundled daemon is local by definition.
    try {
      const status = await daemonUpdateStatus(sendLocal);
      if (status.channel !== "desktop_app" || !status.restart_pending) return false;
      await this.updateDaemon({ pollMs, transport: sendLocal });
      return true;
    } catch {
      // An older daemon without the RPC, or agents are busy; both are fine.
      return false;
    }
  },

  revealPanel(panelId: PanelId, options: { activate?: boolean } = {}) {
    const descriptor = panelDescriptor(panelId);
    if (!descriptor) return;
    if (!visiblePanelIds(layoutStore.layout()).includes(panelId)) layoutStore.addPanel(panelId);
    const leafId = layoutStore.leafOf(panelId);
    if (leafId) layoutStore.setCollapsed(leafId, false);
    if (options.activate !== false) layoutStore.activatePanel(panelId);
    layoutStore.focusPanel(panelId);
  },

  // --- Repository / project -------------------------------------------------
  async addRepository(input: AddRepositoryInput): Promise<string | undefined> {
    logAction("add_repository", { path: input.path, name: input.name });
    const res = ensureOk(
      await send({
        type: "add_repository",
        path: input.path,
        name: input.name,
        remote_name: input.remoteName,
        default_branch: input.defaultBranch,
      }),
    );
    await refreshInventory();
    return res.type === "repository_added" ? res.name : undefined;
  },

  async cloneRepository(input: { url: string; dest: string; name?: string }): Promise<string | undefined> {
    logAction("clone_repository", { url: input.url, dest: input.dest });
    const res = ensureOk(
      await send({ type: "clone_repository", url: input.url, dest: input.dest, name: input.name }),
    );
    await refreshInventory();
    return res.type === "repository_added" ? res.name : undefined;
  },

  /** Drop a repository registration + its workspace records (DB-only). */
  async removeRepository(name: string): Promise<void> {
    logAction("remove_repository", { name });
    ensureOk(await send({ type: "remove_repository", repository: name }));
    await refreshInventory();
    // If we were viewing a workspace that belonged to the removed repo, it's
    // gone now — fall back to the dashboard.
    const sel = nav.selectedWorkspace();
    if (sel && !workspacesStore.row(sel)) nav.goToPage("dashboard");
  },

  // --- Workspace creation ---------------------------------------------------
  async createWorkspace(input: CreateWorkspaceInput): Promise<string | undefined> {
    logAction("create_workspace", input);
    const res = ensureOk(
      await send({
        type: "create_workspace",
        repository: input.repository,
        name: input.name,
        branch: input.branch,
        base_ref: input.baseRef,
      }),
    );
    return this.afterCreate(res);
  },

  async createWorkspaceFromPrompt(input: {
    repository: string;
    prompt: string;
    name?: string;
    branch?: string;
    baseRef?: string;
  }): Promise<string | undefined> {
    logAction("create_workspace_from_prompt", { repository: input.repository, name: input.name });
    const res = ensureOk(
      await send({
        type: "create_workspace_from_prompt",
        repository: input.repository,
        prompt: input.prompt,
        name: input.name,
        branch: input.branch,
        base_ref: input.baseRef,
      }),
    );
    return this.afterCreate(res);
  },

  // Prompt tab: create a workspace with an autogenerated codename. If a prompt is
  // given, send it as the first chat message so the agent runs and renames the
  // workspace + branch via its <archductor_metadata> directive. An empty prompt
  // just creates an empty workspace (no message sent).
  async createWorkspaceFromPromptMessage(input: {
    repository: string;
    prompt?: string;
  }): Promise<string | undefined> {
    const prompt = input.prompt?.trim() ?? "";
    logAction("create_workspace_from_prompt_message", { repository: input.repository, hasPrompt: !!prompt });
    // Empty name/branch → backend autogenerates a linux/distro codename + lc/<slug>.
    const created = ensureOk(
      await send({ type: "create_workspace", repository: input.repository, name: "", branch: "" }),
    );
    const name = created.type === "workspace_created" ? created.name : undefined;
    if (!name) throw new Error("workspace creation returned no name");
    await refreshInventory();

    let threadId: number | undefined;
    if (prompt) {
      const thread = ensureOk(
        await send({ type: "create_chat_thread", workspace: name, provider: "codex", title: "New chat" }),
      );
      threadId = thread.type === "chat_thread_created" ? thread.thread.id : undefined;
      if (threadId != null) {
        await send({ type: "ensure_chat_thread_session", workspace: name, thread_id: threadId, kind: "codex" });
        await send({
          type: "queue_chat_input",
          thread_id: threadId,
          input: prompt,
          kind: "user",
          session_kind: "codex",
        });
      }
    }
    if (workspacesStore.row(name)) nav.selectWorkspace(name);
    if (threadId != null) nav.selectChatThread(threadId);
    return name;
  },

  /**
   * Copy a workspace on the selected remote daemon onto this machine.
   *
   * Reads the repository URL, branch, and (optionally) a conversation from the
   * remote, then writes to the *local* daemon via `sendLocal`. Using `send` for
   * the write would recreate the workspace on the machine it came from.
   *
   * The branch is the work, and it crosses machines through the git remote:
   * the source must be committed, and is pushed here before the import so the
   * local workspace starts at its tip. Any uncommitted source changes are
   * committed first, so the copy carries the full working tree.
   *
   * Throws `MissingLocalRepositoryError` when this machine has no clone and no
   * `cloneInto` was given; picking a directory is the user's call, not ours.
   * `threadId: "latest"` carries the workspace's most recently active chat.
   */
  async importWorkspaceFromRemote(input: {
    workspace: string;
    fromDaemon: SelectedDaemon;
    threadId?: number | "latest";
    cloneInto?: string;
  }): Promise<{ workspace: string; threadId?: number }> {
    logAction("import_workspace_from_remote", {
      workspace: input.workspace,
      thread_id: input.threadId ?? "none",
      clone_into: input.cloneInto ?? "none",
    });
    const sendSource = (req: Parameters<typeof sendToDaemon>[1]) =>
      sendToDaemon(input.fromDaemon, req);
    const remoteWorkspaces = ensureOk(await sendSource({ type: "list_workspaces" }));
    if (remoteWorkspaces.type !== "workspaces") throw new Error("could not list remote workspaces");
    const source = remoteWorkspaces.workspaces.find((w) => w.name === input.workspace);
    if (!source) throw new Error(`${input.workspace} is not a workspace on the connected daemon`);

    const remoteRepos = ensureOk(await sendSource({ type: "list_repositories" }));
    if (remoteRepos.type !== "repositories") throw new Error("could not list remote repositories");
    const repositoryUrl = remoteRepos.repositories.find(
      (repo) => repo.name === source.repository_name,
    )?.remote_url;
    if (!repositoryUrl) {
      throw new Error(
        `${source.repository_name} has no remote URL on that daemon, so there is nothing to match a local clone against`,
      );
    }

    let threadId = input.threadId;
    let provider: string | undefined;
    if (threadId != null) {
      const listed = ensureOk(await sendSource({ type: "list_chat_threads", workspace: source.name }));
      const threads = listed.type === "chat_threads" ? listed.threads : [];
      const thread =
        threadId === "latest"
          ? threads
              .filter((candidate) => !candidate.archived_at)
              .sort((a, b) => Number(b.updated_at) - Number(a.updated_at))[0]
          : threads.find((candidate) => candidate.id === threadId);
      if (threadId === "latest") threadId = thread?.id;
      // The chat continues under the agent it was held with; the daemon would
      // otherwise default an imported chat to Codex.
      provider = thread?.provider;
    }
    let transcript: { role: string; content: string; created_at: string }[] = [];
    let chatTitle: string | undefined;
    if (threadId != null) {
      const chat = ensureOk(await sendSource({ type: "get_chat_transcript", thread_id: threadId }));
      if (chat.type === "chat_transcript") {
        transcript = chat.messages;
        chatTitle = chat.title;
      }
    }

    await commitSourceChangesIfNeeded(
      sendSource,
      source.name,
      `Transfer ${source.name} before copying workspace`,
    );
    ensureOk(await sendSource({ type: "push_branch", workspace: source.name }));
    // The commit just pushed: this machine refuses a branch anywhere else — a
    // stale mirror, or a same-path repository an ssh alias matched.
    const head = await sendSource({ type: "get_recent_commits", workspace: source.name, limit: 1 });
    const sourceCommit = head.type === "recent_commits" ? head.log.trim().split(/\s+/)[0] || undefined : undefined;

    if (input.cloneInto) {
      ensureOk(await sendLocal({ type: "clone_repository", url: repositoryUrl, dest: input.cloneInto }));
    }
    const imported = await sendLocal({
      type: "import_workspace_from_remote",
      repository_url: repositoryUrl,
      branch: source.branch,
      source_branch: source.branch,
      source_commit: sourceCommit,
      base_ref: source.base_ref,
      name: source.name,
      transcript,
      chat_title: chatTitle,
      provider,
    });
    if (imported.type === "error" && imported.message.startsWith("no repository here has remote")) {
      throw new MissingLocalRepositoryError(repositoryUrl, source.repository_name);
    }
    ensureOk(imported);
    if (imported.type !== "workspace_imported") throw new Error("import returned no workspace");
    return { workspace: imported.workspace, threadId: imported.thread_id };
  },

  /**
   * "Transfer to…": move a workspace from the connected daemon to another saved
   * one, the desktop's parity surface for `archductor remote transfer`.
   *
   * The difference from `importWorkspaceFromRemote` is the whole point: that one
   * copies, leaving the source running so two daemons can drive one branch and
   * leaving the carried chat inert. This one stops the source's sessions first,
   * starts a session on the target and hands it the conversation, and archives
   * the source only once that landed.
   *
   * `toClientId` is a saved client id, or `null` for this machine. Neither end
   * has to be this machine, which is why it goes through `sendToClient` rather
   * than `sendLocal`.
   *
   * `force` mirrors the CLI: without it a live session on the source refuses the
   * transfer and nothing is pushed.
   *
   * Re-running after a part-way failure is safe: a workspace already on the
   * target whose branch matches is adopted rather than imported again, and a chat
   * already handed its transfer message is left alone.
   */
  async transferWorkspace(input: {
    workspace: string;
    toClientId: string | null;
    toLabel: string;
    /** Label of the daemon the workspace is moving off, for the preamble. */
    fromLabel: string;
    /**
     * The daemon the workspace is moving *off*, captured by the caller from
     * `clientsStore.selectedDaemon()` so it is exactly the one the sidebar is
     * showing — including when `ARCHDUCTOR_ARCHCAR_REMOTE` pins it, which has
     * no client id and is not this machine either.
     *
     * Pinned rather than re-read per call: `send()` resolves the selection per
     * connection (see `open()` in desktop/electron/archcar.ts) and a transfer
     * can run for minutes, so a switch part-way would send the rest of the
     * source's calls — the final archive included — somewhere else.
     */
    fromDaemon: SelectedDaemon;
    force?: boolean;
    /** Clone the repository on the *target* first, when it has no copy. */
    cloneInto?: string;
  }): Promise<{ workspace: string }> {
    logAction("transfer_workspace", {
      workspace: input.workspace,
      from: input.fromDaemon.kind === "client" ? input.fromDaemon.clientId : input.fromDaemon.kind,
      to: input.toClientId ?? "local",
      force: input.force ? "yes" : "no",
    });
    const toClient = input.toClientId;
    const fromDaemon = input.fromDaemon;
    const sendTarget = (req: ArchcarRequest) => sendToClient(toClient, req);
    const sendSource = (req: ArchcarRequest) => sendToDaemon(fromDaemon, req);

    // Both ends must be two daemons, and a configured address is no way to
    // tell: a saved client can point at the very machine the app is running
    // on. Ask each end who it is, as the CLI does — a self-transfer would
    // archive the workspace it had just resumed. An end that will not answer
    // leaves this unchecked rather than blocking the transfer, same as the CLI.
    const sourceIdentity = await daemonIdentity(sendSource);
    const targetIdentity = await daemonIdentity(sendTarget);
    if (sourceIdentity && targetIdentity && sourceIdentity === targetIdentity) {
      throw new Error(
        `${input.fromLabel} and ${input.toLabel} are the same daemon reached two ways; a transfer needs two. Moving a workspace onto the daemon it is already on would archive the very workspace it just resumed.`,
      );
    }

    const remoteWorkspaces = ensureOk(await sendSource({ type: "list_workspaces" }));
    if (remoteWorkspaces.type !== "workspaces") throw new Error("could not list remote workspaces");
    const source = remoteWorkspaces.workspaces.find((w) => w.name === input.workspace);
    if (!source) throw new Error(`${input.workspace} is not a workspace on the connected daemon`);

    const remoteRepos = ensureOk(await sendSource({ type: "list_repositories" }));
    if (remoteRepos.type !== "repositories") throw new Error("could not list remote repositories");
    const repositoryUrl = remoteRepos.repositories.find(
      (repo) => repo.name === source.repository_name,
    )?.remote_url;
    if (!repositoryUrl) {
      throw new Error(
        `${source.repository_name} has no remote URL on that daemon, so there is nothing for ${input.toLabel} to match a clone against`,
      );
    }

    // Step 1: stop. Before the push, because the branch about to be published is
    // the one an agent on the source is still writing.
    const listed = ensureOk(await sendSource({ type: "list_chat_threads", workspace: source.name }));
    const threads = (listed.type === "chat_threads" ? listed.threads : []).filter(
      (thread) => !thread.archived_at,
    );
    const live: { session: number; provider: string; title: string }[] = [];
    for (const thread of threads) {
      const snapshot = await sendSource({
        type: "get_chat_snapshot",
        thread_id: thread.id,
        include_provider_events: false,
      });
      if (snapshot.type !== "chat_snapshot") continue;
      const session = snapshot.snapshot.live_session;
      // The chat-thread id and the session id are different keys: `kill_session`
      // takes a session-process id, and the snapshot is what maps one to the
      // other.
      if (session && !TERMINAL_SESSION_STATES.has(session.runtime_state) && session.status === "running") {
        live.push({ session: session.session_id, provider: thread.provider, title: thread.title });
      }
    }
    if (live.length > 0 && !input.force) {
      const named = live.map((l) => `session ${l.session} (${l.provider}, "${l.title}")`).join(", ");
      throw new LiveSourceSessionError(
        `${source.name} still has ${live.length === 1 ? "a session" : `${live.length} sessions`} running: ${named}. Nothing has been pushed and nothing has changed.`,
      );
    }
    for (const entry of live) {
      ensureOk(await sendSource({ type: "kill_session", session_id: entry.session }));
    }
    // Polled, not slept on: the push must not race an agent still writing files.
    for (const entry of live) {
      await waitForSessionGone(fromDaemon, entry.session);
    }

    // Which chat moves: the most recently touched live one.
    const moving = [...threads].sort((a, b) => Number(b.updated_at) - Number(a.updated_at))[0];
    let transcript: { role: string; content: string; created_at: string }[] = [];
    let chatTitle: string | undefined;
    if (moving) {
      const chat = ensureOk(await sendSource({ type: "get_chat_transcript", thread_id: moving.id }));
      if (chat.type === "chat_transcript") {
        transcript = chat.messages;
        chatTitle = chat.title;
      }
    }

    // Step 2: publish. Commit any source changes first so the branch push
    // carries the full working tree to the target.
    await commitSourceChangesIfNeeded(
      sendSource,
      source.name,
      `Transfer ${source.name} before moving workspace`,
    );
    ensureOk(await sendSource({ type: "push_branch", workspace: source.name }));
    const head = await sendSource({ type: "get_recent_commits", workspace: source.name, limit: 1 });
    const sourceCommit =
      head.type === "recent_commits" ? head.log.trim().split(/\s+/)[0] || undefined : undefined;

    // Step 3: create on the target, or adopt what an earlier attempt left there.
    // `import_workspace_from_remote` writes through whichever daemon serves it,
    // so pointing the request at the target is all it takes.
    const onTarget = ensureOk(await sendTarget({ type: "list_workspaces" }));
    if (onTarget.type !== "workspaces") throw new Error(`could not list workspaces on ${input.toLabel}`);
    // Adopt only this transfer's own earlier attempt. A branch or a workspace
    // name is not an identity — two repositories routinely share both — and an
    // archived workspace is not a live attempt: resuming inside one would look
    // like success while being invisible on the target's board. Same three
    // checks as `existing_target_workspace` in crates/cli/src/main.rs.
    const targetRepos = ensureOk(await sendTarget({ type: "list_repositories" }));
    const targetRepository =
      targetRepos.type === "repositories"
        ? (targetRepos.repositories.find((repo) => repo.remote_url === repositoryUrl) ??
          targetRepos.repositories.find(
            (repo) =>
              !!repo.remote_url &&
              repositoryUrlTail(repo.remote_url) === repositoryUrlTail(repositoryUrl),
          ))?.name
        : undefined;
    // Everything in this repository, archived included: an archived row is not
    // adoptable but it still *holds its branch*, so it has to be seen here or
    // the import collides with it and the daemon suffixes its way into a second
    // worktree with a second agent on the same conversation.
    const inRepository = onTarget.workspaces.filter(
      (w) => !!targetRepository && w.repository_name === targetRepository,
    );
    const archivedOnBranch = inRepository.find(
      (w) => w.branch === source.branch && w.status === "archived",
    );
    if (archivedOnBranch) {
      throw new Error(
        `${archivedOnBranch.name} on ${input.toLabel} is archived but still holds branch ${archivedOnBranch.branch}, the branch this transfer moves. It cannot be resumed while archived, and importing alongside it would put a second worktree on a -v2 branch with another agent replaying this conversation — so nothing has been changed. Restore it there to continue the transfer into it, or delete it if it is finished with.`,
      );
    }
    const candidates = inRepository.filter((w) => w.status !== "archived");
    const headOf = async (workspace: string): Promise<string | undefined> => {
      const head = await sendTarget({ type: "get_recent_commits", workspace, limit: 1 });
      return head.type === "recent_commits"
        ? head.log.trim().split(/\s+/)[0] || undefined
        : undefined;
    };
    let existing: (typeof candidates)[number] | undefined;
    // Identity first, and by *provenance* rather than by the name this transfer
    // asked for: in this repository, at the commit it pushed. The daemon keeps
    // workspace names unique machine-wide and versions the name and branch
    // together around a collision, so an earlier attempt can be sitting on
    // neither the name nor the branch we would look for — and deriving "is this
    // already transferred" from the requested name/branch is what made a retry
    // import a second copy of it. The pushed commit is the durable record: the
    // target is at it until it does work of its own, and that case refuses.
    if (sourceCommit) {
      for (const candidate of candidates) {
        if (commitsMatch(await headOf(candidate.name), sourceCommit)) {
          existing = candidate;
          break;
        }
      }
    }
    const onBranch = candidates.find((w) => w.branch === source.branch);
    if (!existing && !sourceCommit) {
      // Nothing to compare against. A branch match is taken at face value;
      // re-seeding is still blocked downstream by the delivered-handover check.
      existing = onBranch;
    } else if (!existing && onBranch) {
      // Within one repository a branch name *is* the branch, so a workspace on
      // it that is not at our commit is work that has moved on. Treating that
      // as "not ours, import it" is how a completed transfer got a second
      // workspace on the same branch and its chat seeded twice.
      throw new Error(
        `${onBranch.name} on ${input.toLabel} is on branch ${onBranch.branch} but not at the ${sourceCommit} this transfer pushed — that daemon's copy of this branch has its own commits. Importing a second workspace onto one branch is what this command exists to prevent, and re-seeding its chat would start that work twice, so nothing has been changed. If the transfer already completed there is nothing to re-run; otherwise move or rename it on ${input.toLabel} and try again.`,
      );
    } else if (!existing) {
      // Nothing of ours. Refuse a name already in use anywhere on that daemon
      // before importing: it would be versioned, and a versioned target is one
      // neither this lookup nor a later retry can recognise.
      const taken =
        onTarget.workspaces.find((w) => w.name === source.name) ??
        inRepository.find((w) => w.branch === source.branch);
      if (taken) {
        throw new Error(
          `${input.toLabel} already uses the workspace name ${source.name} for ${taken.name} (${taken.repository_name}, branch ${taken.branch}), and it keeps those names unique — so importing would quietly rename this transfer's workspace and its branch to -v2 forms, leaving something a retry could no longer recognise. Nothing has been changed. Clear that name on ${input.toLabel} first.`,
        );
      }
    }

    let targetWorkspace: string;
    let targetThread: number | undefined;
    if (existing) {
      targetWorkspace = existing.name;
      targetThread = await importedThreadIn(sendTarget, existing.name);
    } else {
      if (input.cloneInto) {
        // Through the target daemon, so the clone is registered as one of its
        // repositories in the same step.
        ensureOk(
          await sendTarget({
            type: "clone_repository",
            url: repositoryUrl,
            dest: input.cloneInto,
          }),
        );
      }
      const afterClone = await sendTarget({ type: "list_repositories" });
      const repositoryResolvedForImport =
        afterClone.type === "repositories" &&
        afterClone.repositories.some(
          (repo) =>
            repo.remote_url === repositoryUrl ||
            (!!repo.remote_url &&
              repositoryUrlTail(repo.remote_url) === repositoryUrlTail(repositoryUrl)),
        );
      const imported = await sendTarget({
        type: "import_workspace_from_remote",
        repository_url: repositoryUrl,
        branch: source.branch,
        source_branch: source.branch,
        source_commit: sourceCommit,
        base_ref: source.base_ref,
        name: source.name,
        transcript,
        chat_title: chatTitle,
        provider: moving?.provider,
      });
      if (imported.type === "error" && imported.message.startsWith("no repository here has remote")) {
        throw new MissingLocalRepositoryError(repositoryUrl, source.repository_name);
      }
      ensureOk(imported);
      if (imported.type !== "workspace_imported") throw new Error("the transfer returned no workspace");
      // The daemon suffixes a branch name it already has anywhere on the
      // machine, so a rename alone is not evidence of trouble — usually it
      // collided with an unrelated repository, which is harmless. It only
      // matters when this repository could not be resolved on the target and
      // so our own branch was never checked: then the rename is the only sign
      // something there is already on it.
      //
      // Re-resolved *after* the clone above, never from the reading taken
      // before it: `cloneInto` registers the repository, so the earlier answer
      // is "no repository here" on every first-time transfer, and deciding on
      // that rejected an ordinary cross-repository rename after the workspace
      // had been created and the source already stopped.
      if (!repositoryResolvedForImport && imported.branch !== source.branch) {
        throw new Error(
          `${input.toLabel} already has branch ${source.branch}, so it created ${imported.workspace} on ${imported.branch} instead. That would be a second worktree on this branch with another agent replaying the same conversation, so the transfer stopped here: nothing was resumed and the source workspace was not archived. Remove ${imported.workspace} on ${input.toLabel}, sort out what already holds ${source.branch} there, and try again.`,
        );
      }
      targetWorkspace = imported.workspace;
      targetThread = imported.thread_id;
    }

    // Step 4: resume. Nothing is archived until the message has landed.
    if (moving && targetThread == null) {
      // A chat moved but the target has no thread for it. Mirrors the CLI: an
      // empty conversation gets a thread opened for it and the continuation
      // prompt, and a conversation with real history that was never seeded is
      // refused rather than silently dropped. Either way the source is not
      // archived on a path where the work never arrived — which is what the
      // unconditional archive below used to do.
      if (transcript.length === 0) {
        const opened = ensureOk(
          await sendTarget({
            type: "create_chat_thread",
            workspace: targetWorkspace,
            provider: moving.provider,
            title: chatTitle ?? "Transferred chat",
          }),
        );
        if (opened.type !== "chat_thread_created") {
          throw new Error(`could not open a chat for ${targetWorkspace} on ${input.toLabel}`);
        }
        targetThread = opened.thread.id;
      } else {
        throw new Error(
          `${targetWorkspace} is on ${input.toLabel} but has none of the conversation, so an earlier attempt created it without the chat. Remove that workspace there and transfer again; ${source.name} has been left alone.`,
        );
      }
    }
    if (targetThread != null && moving) {
      await resumeTransferredChat({
        toClientId: toClient,
        toLabel: input.toLabel,
        fromLabel: input.fromLabel,
        workspace: targetWorkspace,
        threadId: targetThread,
        provider: moving.provider,
        transcript,
        commit: sourceCommit,
      });
    }

    // Step 5: retire. Archive, never delete: the worktree stays on disk.
    ensureOk(await sendSource({ type: "archive_workspace", workspace: source.name }));
    await refreshInventory();
    return { workspace: targetWorkspace };
  },

  /**
   * Fork a chat at a completed turn's timeline point — Conductor's
   * "Fork to new tab" and "Fork to new workspace" actions.
   *
   * `newWorkspace` is the whole difference between the two: the daemon creates
   * the worktree and branch when it is set. Selection follows the fork, because
   * forking and then having to go find the result is not the action anyone
   * meant to take.
   */
  async forkChat(input: {
    threadId: number;
    throughTimelineSeq?: number;
    newWorkspace?: boolean;
  }): Promise<{ workspace: string; threadId: number }> {
    logAction("fork_chat_thread", {
      thread_id: input.threadId,
      through: input.throughTimelineSeq ?? "all",
      target: input.newWorkspace ? "new_workspace" : "same_workspace",
    });
    const response = ensureOk(
      await send({
        type: "fork_chat_thread",
        thread_id: input.threadId,
        through_timeline_seq: input.throughTimelineSeq,
        new_workspace: input.newWorkspace ? {} : undefined,
      }),
    );
    if (response.type !== "chat_thread_forked") throw new Error("fork returned no chat");
    // A new workspace only shows up in the sidebar after a re-pull; a new tab
    // in an existing workspace needs its thread list refreshed the same way.
    await refreshInventory();
    if (response.created_workspace) nav.selectWorkspace(response.workspace);
    nav.selectChatThread(response.thread.id);
    return { workspace: response.workspace, threadId: response.thread.id };
  },

  async createWorkspaceFromIssue(input: {
    repository: string;
    issueNumber: number;
    branchPrefix?: string;
  }): Promise<string | undefined> {
    logAction("create_workspace_from_issue", input);
    const res = ensureOk(
      await send({
        type: "create_workspace_from_issue",
        repository: input.repository,
        issue_number: input.issueNumber,
        branch_prefix: input.branchPrefix,
      }),
    );
    return this.afterCreate(res);
  },

  async createWorkspaceFromPullRequest(input: {
    repository: string;
    prNumber: number;
    name?: string;
    branch?: string;
  }): Promise<string | undefined> {
    logAction("create_workspace_from_pull_request", input);
    const res = ensureOk(
      await send({
        type: "create_workspace_from_pull_request",
        repository: input.repository,
        pr_number: input.prNumber,
        name: input.name,
        branch: input.branch,
      }),
    );
    return this.afterCreate(res);
  },

  async createWorkspaceFromLinear(input: {
    repository: string;
    issueId: string;
    name?: string;
    branch?: string;
    baseRef?: string;
  }): Promise<string | undefined> {
    logAction("create_workspace_from_linear", { repository: input.repository, issueId: input.issueId });
    const res = ensureOk(
      await send({
        type: "create_workspace_from_linear",
        repository: input.repository,
        issue_id: input.issueId,
        name: input.name,
        branch: input.branch,
        base_ref: input.baseRef,
      }),
    );
    return this.afterCreate(res);
  },

  // --- Workspace lifecycle --------------------------------------------------
  /** Hide a workspace from the sidebar. Its worktree, branch, and chats stay. */
  async archiveWorkspace(workspace: string): Promise<void> {
    logAction("archive_workspace", { workspace });
    ensureOk(await send({ type: "archive_workspace", workspace }));
    await refreshInventory();
  },

  async restoreWorkspace(workspace: string): Promise<void> {
    logAction("restore_workspace", { workspace });
    ensureOk(await send({ type: "restore_workspace", workspace }));
    await refreshInventory();
  },

  async renameWorkspace(workspace: string, newName: string): Promise<void> {
    logAction("rename_workspace", { workspace, newName });
    ensureOk(await send({ type: "rename_workspace", workspace, new_name: newName }));
    await refreshInventory();
    if (nav.selectedWorkspace() === workspace) nav.selectWorkspace(newName);
  },

  async duplicateWorkspace(workspace: string, newName: string, branch?: string): Promise<string | undefined> {
    logAction("duplicate_workspace", { workspace, newName, branch });
    const res = ensureOk(
      await send({ type: "duplicate_workspace", workspace, new_name: newName, branch }),
    );
    return this.afterCreate(res);
  },

  /**
   * Remove the workspace's worktree from disk and drop its record. The branch
   * survives unless `deleteBranch` — a different blast radius, so opt-in.
   */
  async deleteWorkspace(workspace: string, deleteBranch = false): Promise<void> {
    logAction("delete_workspace", { workspace, deleteBranch });
    try {
      ensureOk(
        await send({
          type: "delete_workspace",
          workspace,
          remove_worktree: true,
          delete_branch: deleteBranch,
        }),
      );
      if (nav.selectedWorkspace() === workspace) nav.goToPage("dashboard");
    } finally {
      // A failed branch step still deleted the workspace; a refused delete
      // changed nothing. Either way the list should show what is true now —
      // but a failed refresh must not replace the delete's own outcome.
      await refreshInventory().catch((err) => {
        logAction("delete_workspace refresh failed", { workspace, error: String(err) });
      });
    }
  },

  // --- Branch operations ----------------------------------------------------
  async createBranch(workspace: string, branch: string): Promise<void> {
    logAction("create_branch", { workspace, branch });
    ensureOk(await send({ type: "create_branch", workspace, branch }));
    await refreshInventory();
  },

  async checkoutBranch(workspace: string, branch: string): Promise<void> {
    logAction("checkout_branch", { workspace, branch });
    ensureOk(await send({ type: "checkout_branch", workspace, branch }));
    await refreshInventory();
  },

  async renameBranch(workspace: string, newBranch: string): Promise<void> {
    logAction("rename_workspace_branch", { workspace, newBranch });
    ensureOk(await send({ type: "rename_workspace_branch", workspace, new_branch: newBranch }));
    await refreshInventory();
  },

  async deleteBranch(workspace: string, branch: string): Promise<void> {
    logAction("delete_branch", { workspace, branch });
    ensureOk(await send({ type: "delete_branch", workspace, branch }));
    await refreshInventory();
  },

  async pushBranch(workspace: string, force = false): Promise<void> {
    logAction("push_branch", { workspace, force });
    ensureOk(await send({ type: "push_branch", workspace, force }));
    await refreshInventory();
  },

  // Approve/deny/answer/defer an agent interaction (permission, question, plan).
  async resolveInteraction(
    interactionId: string,
    resolution: import("@/bridge/protocol").ProviderInteractionResolution,
  ): Promise<void> {
    logAction("resolve_provider_interaction", { interactionId, resolution: resolution.type });
    ensureOk(
      await send({ type: "resolve_provider_interaction", interaction_id: interactionId, resolution }),
    );
  },

  async resolveReviewThread(workspace: string, threadId: string, resolved: boolean): Promise<void> {
    logAction("resolve_review_thread", { workspace, threadId, resolved });
    ensureOk(await send({ type: "resolve_review_thread", workspace, thread_id: threadId, resolved }));
  },

  // --- Pull request ---------------------------------------------------------
  async refreshPullRequest(workspace: string): Promise<void> {
    logAction("refresh_pull_request", { workspace });
    ensureOk(await send({ type: "refresh_pull_request", workspace }));
    await refreshInventory();
  },

  async mergePullRequest(workspace: string, method?: string): Promise<void> {
    logAction("merge_pull_request", { workspace, method });
    ensureOk(await send({ type: "merge_pull_request", workspace, method }));
    await refreshInventory();
  },

  // --- Review / checkpoint / linking / provider default --------------------
  async addReviewComment(input: {
    workspace: string;
    filePath: string;
    lineNumber?: number;
    body: string;
  }): Promise<void> {
    logAction("add_review_comment", { workspace: input.workspace, file: input.filePath });
    ensureOk(
      await send({
        type: "add_review_comment",
        workspace: input.workspace,
        file_path: input.filePath,
        line_number: input.lineNumber,
        body: input.body,
      }),
    );
  },

  async deleteCheckpoint(workspace: string, checkpointId: number): Promise<void> {
    logAction("delete_checkpoint", { workspace, checkpointId });
    ensureOk(await send({ type: "delete_checkpoint", workspace, checkpoint_id: checkpointId }));
  },

  async linkWorkspaceDirectory(workspace: string, target: string): Promise<void> {
    logAction("link_workspace_directory", { workspace, target });
    ensureOk(await send({ type: "link_workspace_directory", workspace, target }));
  },

  async unlinkWorkspaceDirectory(workspace: string, target: string): Promise<void> {
    logAction("unlink_workspace_directory", { workspace, target });
    ensureOk(await send({ type: "unlink_workspace_directory", workspace, target }));
  },

  async setDefaultAgentProvider(workspace: string, provider: string): Promise<void> {
    logAction("set_default_agent_provider", { workspace, provider });
    ensureOk(await send({ type: "set_default_agent_provider", workspace, provider }));
  },

  /** Shared post-create step: refresh inventory and select the new workspace. */
  async afterCreate(res: ArchcarResponse): Promise<string | undefined> {
    await refreshInventory();
    const name = res.type === "workspace_created" ? res.name : undefined;
    if (name && workspacesStore.row(name)) nav.selectWorkspace(name);
    return name;
  },
};
