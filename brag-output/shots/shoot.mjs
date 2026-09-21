import { chromium } from "playwright";

const SHOTS = new URL(".", import.meta.url).pathname;
const now = Math.floor(Date.now() / 1000);

const repos = [
  { id: 1, name: "conductor-arch", root_path: "/home/kitts/src/conductor-arch", default_branch: "main", remote_name: "origin", remote_url: "git@github.com:perceo-ai/conductor-arch.git", active_workspaces: 7, total_workspaces: 11 },
  { id: 2, name: "archivum", root_path: "/home/kitts/src/archivum", default_branch: "main", remote_name: "origin", remote_url: "git@github.com:perceo-ai/archivum.git", active_workspaces: 2, total_workspaces: 5 },
];

const ws = (o) => ({
  id: 0, name: "x", repository_name: "conductor-arch", path: "/home/kitts/.local/share/archductor/worktrees/x",
  branch: "feat/x", base_ref: "main", status: "active", open_todos: 0, open_tasks: 0, blocked_tasks: 0,
  active_sessions: 0, awaiting_input: false, run_running: false, changed_files: 0,
  diff_additions: 0, diff_deletions: 0, branch_ahead: 0, branch_behind: 0, updated_at: String(now - 300), ...o,
});

const workspaces = [
  ws({ id: 1, name: "fix-auth-refresh", branch: "fix/auth-refresh", awaiting_input: true, active_sessions: 1, changed_files: 4, diff_additions: 128, diff_deletions: 37, open_todos: 2, updated_at: String(now - 90) }),
  ws({ id: 2, name: "remote-ssh-transport", branch: "feat/remote-ssh", active_sessions: 2, run_running: true, changed_files: 11, diff_additions: 642, diff_deletions: 210, open_todos: 3, updated_at: String(now - 45) }),
  ws({ id: 3, name: "layout-presets", branch: "feat/layout-presets", active_sessions: 1, changed_files: 7, diff_additions: 301, diff_deletions: 96, updated_at: String(now - 120) }),
  ws({ id: 4, name: "diff-gutter-polish", branch: "feat/diff-gutter", changed_files: 2, diff_additions: 44, diff_deletions: 12, updated_at: String(now - 900) }),
  ws({ id: 5, name: "service-doctor-path", branch: "fix/service-path", changed_files: 0, updated_at: String(now - 3600) }),
  ws({ id: 6, name: "chat-streaming-perf", branch: "perf/chat-stream", pull_request_number: 118, pull_request_state: "open", pull_request_url: "https://github.com/perceo-ai/conductor-arch/pull/118", changed_files: 9, diff_additions: 418, diff_deletions: 377, updated_at: String(now - 600) }),
  ws({ id: 7, name: "windows-preview-pkg", branch: "ci/windows-pkg", pull_request_number: 121, pull_request_state: "open", pull_request_url: "https://github.com/perceo-ai/conductor-arch/pull/121", changed_files: 3, diff_additions: 61, diff_deletions: 18, updated_at: String(now - 1500) }),
  ws({ id: 8, name: "vault-themes", repository_name: "archivum", branch: "feat/vault-themes", active_sessions: 1, changed_files: 5, diff_additions: 190, diff_deletions: 40, updated_at: String(now - 240) }),
  ws({ id: 9, name: "gtk-app-removal", branch: "chore/drop-gtk", status: "archived", updated_at: String(now - 86400 * 3) }),
];

const chat_threads = {
  "fix-auth-refresh": [{ id: 11, provider: "claude", title: "Token refresh races on reconnect", status: "awaiting_input", model: "claude-opus-5", fast_mode: false, updated_at: String(now - 90) }],
  "remote-ssh-transport": [{ id: 12, provider: "codex", title: "Pipe protocol through stdio-proxy", status: "running", model: "gpt-5-codex", fast_mode: false, updated_at: String(now - 45) }],
  "layout-presets": [{ id: 13, provider: "claude", title: "Immutable builtins, edited copies", status: "running", model: "claude-opus-5", fast_mode: false, updated_at: String(now - 120) }],
};

let seq = 0;
const item = (render_class, role_label, title, body, extra = {}) => ({
  id: `p${++seq}`, sequence: seq, render_class, role_label, title, body,
  status: "complete", stream_state: "complete", timeline_seq: seq, ...extra,
});

const projection = [
  item("user_chat", "You", "", "Run the archcar protocol over SSH instead of a bare TCP port. No open listener, no shared token — the client should just spawn the daemon's stdio proxy on the far side."),
  item("reasoning_card", "Thinking", "", "The transport already speaks newline-delimited JSON over a Unix socket, so an SSH pipe is the same stream with a different pair of file descriptors. The work is in the client: resolve `ssh://user@host[/path]`, hand the destination to `ssh` verbatim so `~/.ssh/config` still applies, and treat the child's stdin/stdout as the socket."),
  item("command_card", "Codex", "Ran cargo test -p archductor-core transport::", ""),
  item("file_card", "Codex", "Read crates/core/src/archcar/transport.rs", ""),
  item("diff_card", "Codex", "Edited crates/core/src/remote/ssh.rs", ""),
  item("diff_card", "Codex", "Edited crates/cli/src/commands/remote.rs", ""),
  item("command_card", "Codex", "Ran cargo clippy --workspace --all-targets", ""),
  item("assistant_chat", "Codex", "", "Added an `ssh://` transport that runs `archductor archcar stdio-proxy` on the remote host and pipes the protocol through the SSH connection.\n\n- **No open port.** `service install` needs no `--listen` at all.\n- **Per-user identity.** Auth is the operator's SSH key, so revoking one user is a line in `authorized_keys` rather than a token rotation that cuts off everybody.\n- **Host aliases work.** The destination is passed to `ssh` verbatim, so jump hosts and per-host keys resolve from `~/.ssh/config`.\n\n`remote connect ssh://you@server` now round-trips against the two-host Docker spike, and `remote status` reports the transport it chose."),
];

const changes = [
  { path: "crates/core/src/remote/ssh.rs", additions: 214, deletions: 0, staged: false, unstaged: true, untracked: false },
  { path: "crates/core/src/remote/mod.rs", additions: 38, deletions: 11, staged: false, unstaged: true, untracked: false },
  { path: "crates/core/src/archcar/transport.rs", additions: 96, deletions: 54, staged: false, unstaged: true, untracked: false },
  { path: "crates/cli/src/commands/remote.rs", additions: 121, deletions: 47, staged: false, unstaged: true, untracked: false },
  { path: "crates/cli/src/commands/service.rs", additions: 44, deletions: 29, staged: false, unstaged: true, untracked: false },
  { path: "desktop/src/store/clients.ts", additions: 52, deletions: 18, staged: false, unstaged: true, untracked: false },
  { path: "desktop/src/components/ClientSwitcher.tsx", additions: 31, deletions: 9, staged: false, unstaged: true, untracked: false },
  { path: "docs/api.md", additions: 26, deletions: 12, staged: false, unstaged: true, untracked: false },
  { path: "README.md", additions: 14, deletions: 30, staged: false, unstaged: true, untracked: false },
  { path: "tests/remote_ssh.rs", additions: 6, deletions: 0, staged: false, unstaged: true, untracked: true },
];

const DIFF = `diff --git a/crates/core/src/remote/ssh.rs b/crates/core/src/remote/ssh.rs
new file mode 100644
--- /dev/null
+++ b/crates/core/src/remote/ssh.rs
@@ -0,0 +1,34 @@
+/// Run the daemon's stdio proxy on the far side and pipe the protocol through
+/// the SSH connection. No listener, no shared secret: the transport inherits
+/// sshd's encryption and the operator's own key as its identity.
+pub struct SshTransport {
+    child: Child,
+    reader: BufReader<ChildStdout>,
+}
+
+impl SshTransport {
+    pub fn connect(dest: &SshDestination) -> Result<Self> {
+        // Hand the destination to ssh verbatim so ~/.ssh/config still applies:
+        // host aliases, jump hosts and per-host keys all keep working.
+        let mut cmd = Command::new("ssh");
+        cmd.arg(dest.target())
+            .arg(dest.remote_binary())
+            .args(["archcar", "stdio-proxy"])
+            .stdin(Stdio::piped())
+            .stdout(Stdio::piped());
+
+        let mut child = cmd.spawn().context("spawn ssh")?;
+        let stdout = child.stdout.take().expect("piped");
+        Ok(Self { child, reader: BufReader::new(stdout) })
+    }
+}
diff --git a/crates/cli/src/commands/remote.rs b/crates/cli/src/commands/remote.rs
--- a/crates/cli/src/commands/remote.rs
+++ b/crates/cli/src/commands/remote.rs
@@ -61,13 +74,19 @@ pub fn connect(args: ConnectArgs) -> Result<()> {
-    let token = args.token.context("--token is required")?;
-    let profile = RemoteProfile::tcp(args.address, token);
+    let profile = match RemoteTarget::parse(&args.address)? {
+        RemoteTarget::Ssh(dest) => RemoteProfile::ssh(dest),
+        RemoteTarget::Tcp(addr) => {
+            let token = args.token.context("--token is required for tcp")?;
+            RemoteProfile::tcp(addr, token)
+        }
+    };
     profile.save()?;
-    println!("connected to {}", profile.address());
+    println!("connected to {} over {}", profile.address(), profile.transport());
     Ok(())
 }
`;

const SETTINGS_TOML = `[customization.view]
default_layout_preset = "code"

[merge]
block_on_open_todos = true
block_on_unresolved_comments = true
block_on_failing_checks = true
`;

const unhandled = new Set();
function respond(p) {
  switch (p.type) {
    case "get_inventory_snapshot":
      return { type: "inventory_snapshot", repositories: repos, workspaces, chat_threads };
    case "get_setup_readiness":
      return { type: "setup_readiness", report: { rows: [], feedback: "", complete: true } };
    case "list_layout_presets": return { type: "layout_presets", presets: [] };
    case "list_workspaces": return { type: "workspaces", workspaces };
    case "list_repositories": return { type: "repositories", repositories: repos };
    case "list_background_tasks": return { type: "background_tasks", tasks: [] };
    case "list_agent_providers":
      return { type: "agent_providers", providers: [
        { id: "claude", label: "Claude Code", available: true, models: [] },
        { id: "codex", label: "Codex", available: true, models: [] },
      ] };
    case "get_settings":
    case "get_settings_source":
      return { type: "settings", scope: p.scope ?? "repository", toml: SETTINGS_TOML };
    case "list_chat_threads":
      return { type: "chat_threads", workspace: p.workspace, threads: chat_threads[p.workspace] ?? [] };
    case "get_chat_projection":
      return { type: "chat_projection", thread_id: p.thread_id, items: p.thread_id === 12 ? projection : [] };
    case "get_chat_snapshot":
      return { type: "chat_snapshot", snapshot: {
        thread_id: p.thread_id, messages: [], events: [], provider_events: [], queued_inputs: [],
        live_session: { session_id: 5, status: "running", runtime_state: "idle", ready: true },
      } };
    case "get_workspace_changes":
      return { type: "workspace_changes", workspace: p.workspace, scope: p.scope, files: changes };
    case "get_workspace_diff":
      return { type: "workspace_diff", workspace: p.workspace, diff: DIFF };
    case "get_checks_summary":
      return { type: "checks_summary", summary: { workspace: p.workspace, changed_files: 11, run_status: "running", check_status: "passed", check_exit_code: 0, session_status: "running", active_sessions: 2, open_todos: 3, total_todos: 9, open_review_comments: 1, source_branch_ahead: 4, branch_ahead: 4, branch_behind: 0 } };
    case "list_todos": return { type: "todos", workspace: p.workspace, todos: [] };
    case "list_review_comments": return { type: "review_comments", workspace: p.workspace, comments: [] };
    case "list_workspace_conflicts": return { type: "workspace_conflicts", workspace: p.workspace, conflicts: [] };
    case "list_workspace_timeline": return { type: "workspace_timeline", workspace: p.workspace, events: [] };
    case "list_context_plans": return { type: "context_plans", workspace: p.workspace, plans: [] };
    case "list_chat_transcripts": return { type: "chat_transcripts", workspace: p.workspace, transcripts: [] };
    case "list_workspace_files": return { type: "workspace_files", workspace: p.workspace, files: [] };
    case "list_tasks": return { type: "tasks", workspace: p.workspace, tasks: [] };
    case "list_summaries": return { type: "summaries", workspace: p.workspace, summaries: [] };
    case "list_workspace_run_scripts": return { type: "workspace_run_scripts", workspace: p.workspace, scripts: [] };
    case "get_workspace_checks": case "list_workspace_checks":
      return { type: "workspace_checks", workspace: p.workspace, checks: [] };
    default:
      unhandled.add(p.type);
      return { type: "ack" };
  }
}

const stub = () => {
  window.archductor = {
    request: (payload) => window.__respond(payload),
    requestLocal: (payload) => window.__respond(payload),
    ensureEvents: async () => ({ ok: true }),
    onEvent: () => () => {},
    onWindowFocus: () => () => {},
    window: { minimize() {}, toggleMaximize() {}, close() {} },
    selectFolder: async () => null,
    listGithubRepos: async () => ({ ok: true, repos: [] }),
    listGithubWork: async () => ({ ok: true, items: [] }),
    pathExists: async () => ({ exists: true }),
    clientsList: async () => ({ ok: true, activeId: null, clients: [] }),
    clientsAdd: async () => ({ ok: true, activeId: null, clients: [] }),
    clientsActivate: async () => ({ ok: true, activeId: null, clients: [] }),
    clientsRemove: async () => ({ ok: true, activeId: null, clients: [] }),
    clientsRename: async () => ({ ok: true, activeId: null, clients: [] }),
    listWorkspaceFiles: async () => ({ ok: true, files: [] }),
    repoAvatar: async () => ({ ok: false, error: "none" }),
    openExternal: async () => ({ ok: true }),
    openWorkspaceApp: async () => ({ ok: true }),
    checkForUpdates: async () => ({ ok: true, currentVersion: "0.9.0", updateAvailable: false }),
    remoteGet: async () => ({ ok: true, address: null, source: null }),
    remoteSet: async () => ({ ok: true, address: "" }),
    remoteClear: async () => ({ ok: true }),
  };
};

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 2 });
await ctx.exposeFunction("__respond", (payload) => respond(payload));
await ctx.addInitScript(stub);
const page = await ctx.newPage();
page.on("pageerror", (e) => console.log("PAGEERROR:", e.message));
await page.goto("http://127.0.0.1:8731/index.html", { waitUntil: "networkidle" });
await page.waitForTimeout(2500);
await page.screenshot({ path: SHOTS + "01-dashboard.png" });

await page.getByText("Remote Ssh Trans", { exact: false }).first().click();
await page.waitForTimeout(1800);
const tab = page.locator("text=Chat 1").first();
if (await tab.count()) { await tab.click(); await page.waitForTimeout(1500); }
await page.screenshot({ path: SHOTS + "02-chat.png" });

const fileRow = page.getByText("crates/cli/src/commands/remote.rs", { exact: false }).last();
if (await fileRow.count()) { await fileRow.click(); await page.waitForTimeout(2000); }
await page.screenshot({ path: SHOTS + "03-diff.png" });

await page.keyboard.press("Meta+KeyK");
await page.waitForTimeout(900);
await page.screenshot({ path: SHOTS + "04-palette.png" });
await page.keyboard.press("Escape");
await page.waitForTimeout(500);

// Wide window, dashboard, for the hero shot.
await page.setViewportSize({ width: 1920, height: 1080 });
await page.getByText("Dashboard", { exact: true }).first().click();
await page.waitForTimeout(1500);
await page.screenshot({ path: SHOTS + "05-dashboard-wide.png" });

console.log("UNHANDLED:", [...unhandled].join(", "));
await browser.close();
