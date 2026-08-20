import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { execFile, execFileSync, spawn } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import {
  ArchcarBridge,
  loadClients,
  loadRemoteConfig,
  remoteHandlerBlock,
  saveClients,
  upsertClient,
} from "./archcar.js";
import { parseGithubRepos } from "./githubRepos.js";
import { resolveWindowIconPath } from "./icon.js";
import { externalNavigationUrl, isExternalOpenTarget } from "./externalNavigation.js";

const execFileP = promisify(execFile);

// GUI apps launched from a desktop entry (not a terminal) inherit a minimal
// PATH that often omits gh/git — spawns then fail with ENOENT. Resolve the
// user's real login-shell PATH once and reuse it for every subprocess.
let cachedPath: string | null = null;
function shellPath(): string {
  if (cachedPath != null) return cachedPath;
  const extra = [
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
    "/opt/homebrew/bin",
    "/home/linuxbrew/.linuxbrew/bin",
    path.join(os.homedir(), ".local/bin"),
    path.join(os.homedir(), "bin"),
  ];
  let base = process.env.PATH ?? "";
  try {
    const shell = process.env.SHELL || "/bin/sh";
    const out = execFileSync(shell, ["-lc", "printf %s \"$PATH\""], {
      encoding: "utf8",
      timeout: 3000,
    }).trim();
    if (out) base = out;
  } catch {
    // Fall back to the process PATH plus common install dirs.
  }
  cachedPath = [base, ...extra].filter(Boolean).join(":");
  return cachedPath;
}

/** Spawn env with a PATH that can actually find gh/git. */
function spawnEnv(): NodeJS.ProcessEnv {
  return { ...process.env, PATH: shellPath() };
}

function skipWorkspaceFilePath(relativePath: string): boolean {
  return relativePath
    .split(/[\\/]/)
    .some((part) => part === ".git" || part === "target" || part === "node_modules");
}

function listFilesRecursive(root: string, current: string, files: string[], cap: number): void {
  if (files.length >= cap) return;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(current, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (files.length >= cap) return;
    if (entry.name === ".git" || entry.name === "target" || entry.name === "node_modules") continue;
    if (entry.isSymbolicLink()) continue;
    const full = path.join(current, entry.name);
    if (entry.isDirectory()) {
      listFilesRecursive(root, full, files, cap);
      continue;
    }
    if (entry.isFile()) {
      const relative = path.relative(root, full);
      if (relative && !relative.startsWith("..") && !path.isAbsolute(relative)) files.push(relative);
    }
  }
}

async function listWorkspaceFilesLocal(rootPath: string, cap = 400): Promise<string[]> {
  const root = path.resolve(rootPath);
  if (cap <= 0) return [];
  try {
    const { stdout } = await execFileP(
      "git",
      ["-C", root, "ls-files", "-z", "--cached", "--others", "--exclude-standard"],
      { encoding: "utf8", env: spawnEnv(), timeout: 3000, maxBuffer: 1024 * 1024 },
    );
    return stdout
      .split("\0")
      .filter(Boolean)
      .filter((file) => !skipWorkspaceFilePath(file))
      .slice(0, cap)
      .sort();
  } catch {
    const files: string[] = [];
    listFilesRecursive(root, root, files, cap);
    return files.sort().slice(0, cap);
  }
}

function normalizeVersion(value: string): number[] {
  return value
    .trim()
    .replace(/^v/i, "")
    .split(/[.-]/)
    .slice(0, 3)
    .map((part) => Number.parseInt(part, 10))
    .map((part) => (Number.isFinite(part) ? part : 0));
}

function compareVersions(left: string, right: string): number {
  const a = normalizeVersion(left);
  const b = normalizeVersion(right);
  for (let i = 0; i < 3; i += 1) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// --- Persistent desktop logfile (parity with gtk-app logger.rs) -----------
// Every renderer action/state-change and every main-process IPC call is
// appended here so a bug report has the full trigger→state trail off-console.
function logDir(): string {
  const xdg = process.env.XDG_STATE_HOME;
  const base = xdg && xdg.trim().length > 0 ? xdg : path.join(os.homedir(), ".local/state");
  return path.join(base, "archductor");
}
const LOG_PATH = path.join(logDir(), "desktop.log");
let logStream: fs.WriteStream | null = null;
function logLine(category: string, message: string, data?: unknown): void {
  const iso = new Date().toISOString();
  let line = `${iso} [${category}] ${message}`;
  if (data !== undefined) {
    try {
      line += ` ${JSON.stringify(data)}`;
    } catch {
      line += ` ${String(data)}`;
    }
  }
  // eslint-disable-next-line no-console
  console.log(line);
  try {
    if (!logStream) {
      fs.mkdirSync(logDir(), { recursive: true });
      logStream = fs.createWriteStream(LOG_PATH, { flags: "a" });
    }
    logStream.write(line + "\n");
  } catch {
    // logging must never crash the app
  }
}

// On Linux the Chromium zygote fails to fork child processes on some
// kernel/sandbox combos (kernel 7.x + Electron 33), cascading into GPU and
// network-service launch failures and a black window. Skipping the zygote
// spawns children directly and keeps the sandbox intact. Must run before the
// app is ready. See gpu_process_host "GPU process isn't usable. Goodbye." loop.
if (process.platform === "linux") {
  app.commandLine.appendSwitch("no-zygote");
}

// Vite injects these in dev; undefined in a packaged build.
const DEV_SERVER_URL = process.env.VITE_DEV_SERVER_URL;

let win: BrowserWindow | null = null;

// Send to the renderer only when the frame is alive. Window events (focus/blur)
// and async daemon events can fire while the render frame is being disposed
// (HMR full-reload, window close, dev electron restart); sending then throws
// "Render frame was disposed before WebFrameMain could be accessed".
function sendToRenderer(channel: string, ...args: unknown[]): void {
  if (!win || win.isDestroyed()) return;
  const wc = win.webContents;
  if (!wc || wc.isDestroyed() || wc.isCrashed()) return;
  wc.send(channel, ...args);
}
const bridge = new ArchcarBridge();

function createWindow() {
  const icon = resolveWindowIconPath({
    moduleDir: __dirname,
    resourcesPath: process.resourcesPath,
    platform: process.platform,
  });
  win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: "#191919",
    ...(icon ? { icon } : {}),
    // Frameless so we can render the GTK-style custom window chrome on Linux/Win.
    // macOS keeps native traffic lights via hiddenInset.
    frame: process.platform === "darwin",
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.mjs"),
      contextIsolation: true,
      nodeIntegration: false,
      // ESM preload (.mjs): Electron only loads ES-module preloads when the
      // renderer is unsandboxed. contextIsolation still fully isolates the
      // preload's context from page JS, and the preload only touches
      // contextBridge/ipcRenderer — no untrusted code runs here.
      sandbox: false,
    },
  });

  win.once("ready-to-show", () => win?.show());

  // Links belong in the user's browser, never in the app shell. The renderer
  // intercepts anchor clicks itself; these two guards catch what it can't
  // (target="_blank", window.open, redirects) so a web page can never replace
  // the SPA or spawn a chrome-less Electron window.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isExternalOpenTarget(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (event, url) => {
    const external = externalNavigationUrl(url, DEV_SERVER_URL ?? null);
    if (!external) return;
    event.preventDefault();
    void shell.openExternal(external);
  });

  win.on("focus", () => sendToRenderer("window:focus", true));
  win.on("blur", () => sendToRenderer("window:focus", false));

  if (DEV_SERVER_URL) {
    win.loadURL(DEV_SERVER_URL);
    win.webContents.openDevTools({ mode: "detach" });
  } else {
    win.loadFile(path.join(__dirname, "../dist/index.html"));
  }
}

// --- IPC: renderer <-> archcar bridge -------------------------------------

// Renderer → persistent logfile.
ipcMain.on("app:log", (_evt, entry: { category: string; message: string; data?: unknown }) => {
  if (!entry || typeof entry.message !== "string") return;
  logLine(entry.category ?? "log", entry.message, entry.data);
});

function requestType(payload: unknown): string {
  return (payload as { type?: string })?.type ?? "unknown";
}

// One-shot request/response.
ipcMain.handle("archcar:request", async (_evt, payload: unknown) => {
  const type = requestType(payload);
  logLine("rpc", `request ${type}`);
  try {
    const res = await bridge.request(payload as never);
    logLine("rpc", `response ${type} → ${requestType(res)}`);
    return { ok: true, value: res };
  } catch (err) {
    logLine("error", `request ${type} failed: ${(err as Error).message}`);
    return { ok: false, error: (err as Error).message };
  }
});

ipcMain.handle("fs:list-workspace-files", async (_evt, opts: { rootPath?: string; cap?: number }) => {
  try {
    if (loadRemoteConfig()) {
      return { ok: false, error: "remote daemon configured; use archcar workspace file listing" };
    }
    if (!opts?.rootPath) return { ok: false, error: "missing workspace path" };
    const files = await listWorkspaceFilesLocal(opts.rootPath, opts.cap ?? 400);
    return { ok: true, files };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
});

// Start the event subscription, forwarding each event to the renderer. Auto
// reconnects with backoff if the daemon connection drops.
let subscribing = false;
async function startSubscription() {
  if (subscribing) return;
  subscribing = true;
  const forward = (event: unknown) => {
    logLine("event", requestType(event));
    sendToRenderer("archcar:event", event);
  };
  const reconnect = () => {
    subscribing = false;
    setTimeout(() => startSubscription(), 500);
  };
  try {
    await bridge.subscribe(forward, reconnect);
  } catch {
    reconnect();
  }
}

ipcMain.handle("archcar:subscribe", async () => {
  await startSubscription();
  return { ok: true };
});

// --- Remote daemon configuration (server-hosted execution) -----------------
// The profile file is shared with the CLI (`archductor remote connect`), so
// either surface can point this machine at a server-hosted archcar. The token
// never crosses to the renderer on read.

ipcMain.handle("archcar:remote-get", async () => {
  try {
    const envAddress = process.env.ARCHDUCTOR_ARCHCAR_REMOTE?.trim();
    const config = loadRemoteConfig();
    return {
      ok: true,
      address: config?.address ?? null,
      source: config ? (envAddress ? "environment" : "profile") : null,
    };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
});

ipcMain.handle(
  "archcar:remote-set",
  async (_evt, config: { address?: string; token?: string } | undefined) => {
    const address = config?.address?.trim();
    const token = config?.token?.trim();
    if (!address || !token) return { ok: false, error: "address and token are required" };
    // The env override would make the verification below hit the env remote,
    // not the profile being saved — a success would be a lie.
    if (process.env.ARCHDUCTOR_ARCHCAR_REMOTE?.trim()) {
      return {
        ok: false,
        error:
          "ARCHDUCTOR_ARCHCAR_REMOTE is set and overrides the profile; unset it to configure the connection here",
      };
    }
    // Goes through the saved-client list so a connection made here also shows
    // up in the switcher; `saveClients` writes the profile mirror. Keep the
    // previous selection so a typo doesn't destroy a working connection.
    try {
      const previous = loadClients();
      const next = loadClients();
      const id = upsertClient(next, undefined, address, token);
      next.active_id = id;
      const res = await activateClients(next, previous, true);
      if (!res.ok) return { ok: false, error: res.error };
      logLine("remote", `connected to archcar at ${address}`);
      return { ok: true, address };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  },
);

ipcMain.handle("archcar:remote-clear", async () => {
  try {
    const file = loadClients();
    delete file.active_id;
    saveClients(file);
    logLine("remote", "cleared remote profile; using the local daemon");
    bridge.close();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
});

// --- Saved clients ---------------------------------------------------------
// The switcher manages many daemons; `saveClients` keeps `remote.json` pointed
// at the selected one so every other reader needs no changes.

const envRemoteAddress = () => process.env.ARCHDUCTOR_ARCHCAR_REMOTE?.trim() || null;

/** Tokens never cross to the renderer — the switcher only needs to label rows. */
function clientSummaries(file: ReturnType<typeof loadClients>) {
  return file.clients.map((c) => ({ id: c.id, label: c.label, address: c.address }));
}

/**
 * Point the machine at `next`, prove the daemon answers, and roll the selection
 * back if it does not — a switch that silently lands on a dead host would leave
 * every surface empty with no explanation.
 */
async function activateClients(
  next: ReturnType<typeof loadClients>,
  previous: ReturnType<typeof loadClients>,
  verify: boolean,
): Promise<{ ok: true } | { ok: false; error: string }> {
  saveClients(next);
  if (!verify) {
    bridge.close();
    return { ok: true };
  }
  try {
    const res = await bridge.request<{ type: string }, { type: string; message?: string }>({
      type: "get_remote_access",
    });
    if (res.type === "error") {
      saveClients(previous);
      return { ok: false, error: res.message ?? "the daemon refused the connection" };
    }
  } catch (err) {
    saveClients(previous);
    return { ok: false, error: (err as Error).message };
  }
  // Drop the old event stream; auto-reconnect resubscribes against the new
  // endpoint because open() re-reads the profile.
  bridge.close();
  return { ok: true };
}

ipcMain.handle("clients:list", async () => {
  try {
    const file = loadClients();
    return {
      ok: true,
      activeId: file.active_id ?? null,
      clients: clientSummaries(file),
      envAddress: envRemoteAddress(),
    };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
});

ipcMain.handle(
  "clients:add",
  async (_evt, opts: { label?: string; address?: string; token?: string } | undefined) => {
    const address = opts?.address?.trim();
    const token = opts?.token?.trim();
    if (!address || !token) return { ok: false, error: "address and token are required" };
    if (envRemoteAddress()) {
      return {
        ok: false,
        error:
          "ARCHDUCTOR_ARCHCAR_REMOTE is set and overrides saved clients; unset it to manage them here",
      };
    }
    try {
      const previous = loadClients();
      const next = loadClients();
      const id = upsertClient(next, opts?.label, address, token);
      next.active_id = id;
      const res = await activateClients(next, previous, true);
      if (!res.ok) return res;
      logLine("remote", `connected to archcar at ${address}`);
      return { ok: true, id, clients: clientSummaries(next), activeId: id };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  },
);

ipcMain.handle("clients:activate", async (_evt, id: string | null) => {
  if (envRemoteAddress()) {
    return {
      ok: false,
      error: "ARCHDUCTOR_ARCHCAR_REMOTE is set and overrides saved clients; unset it to switch here",
    };
  }
  try {
    const previous = loadClients();
    const next = loadClients();
    if (id === null) {
      delete next.active_id;
      saveClients(next);
      bridge.close();
      logLine("remote", "switched to the local daemon");
      return { ok: true, activeId: null, clients: clientSummaries(next) };
    }
    const target = next.clients.find((c) => c.id === id);
    if (!target) return { ok: false, error: `no saved client ${id}` };
    next.active_id = id;
    const res = await activateClients(next, previous, true);
    if (!res.ok) return res;
    logLine("remote", `switched to archcar at ${target.address}`);
    return { ok: true, activeId: id, clients: clientSummaries(next) };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
});

ipcMain.handle("clients:remove", async (_evt, id: string) => {
  try {
    const file = loadClients();
    if (!file.clients.some((c) => c.id === id)) return { ok: false, error: `no saved client ${id}` };
    const wasActive = file.active_id === id;
    file.clients = file.clients.filter((c) => c.id !== id);
    if (wasActive) delete file.active_id;
    saveClients(file);
    if (wasActive) bridge.close();
    return {
      ok: true,
      activeId: file.active_id ?? null,
      clients: clientSummaries(file),
    };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
});

ipcMain.handle("clients:rename", async (_evt, opts: { id: string; label: string }) => {
  const label = opts?.label?.trim();
  if (!label) return { ok: false, error: "a name is required" };
  try {
    const file = loadClients();
    const target = file.clients.find((c) => c.id === opts.id);
    if (!target) return { ok: false, error: `no saved client ${opts.id}` };
    target.label = label;
    saveClients(file);
    return { ok: true, activeId: file.active_id ?? null, clients: clientSummaries(file) };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
});

// Native folder picker for path/destination fields in the Add project dialog.
ipcMain.handle(
  "dialog:select-folder",
  async (_evt, opts: { title?: string; defaultPath?: string } | undefined) => {
    const res = await dialog.showOpenDialog(win ?? undefined!, {
      title: opts?.title ?? "Select folder",
      defaultPath: opts?.defaultPath,
      properties: ["openDirectory", "createDirectory"],
    });
    if (res.canceled || res.filePaths.length === 0) return null;
    return res.filePaths[0];
  },
);

// List the signed-in user's GitHub repos via the gh CLI (for the Clone tab).
ipcMain.handle("gh:list-repos", async () => {
  try {
    // Use the REST endpoint (not `gh repo list`, which is owner-only) so org
    // repos and repos we collaborate on are included. affiliation covers all
    // three; sort=pushed + --paginate gives most-recent first across pages.
    const { stdout } = await execFileP(
      "gh",
      [
        "api",
        "--paginate",
        // --slurp merges the per-page arrays into one; without it `gh` emits
        // `[...][...]` (one array per page), which is invalid JSON and makes
        // JSON.parse throw for anyone with >100 matching repos.
        "--slurp",
        "user/repos?per_page=100&sort=pushed&affiliation=owner,collaborator,organization_member",
      ],
      { env: spawnEnv(), maxBuffer: 64 * 1024 * 1024 },
    );
    return { ok: true, repos: parseGithubRepos(stdout) };
  } catch (err) {
    logLine("error", `gh repo list failed: ${(err as Error).message}`);
    return { ok: false, error: (err as Error).message };
  }
});

// Window controls for the custom (frameless) chrome.
// Resolve a repo's owner avatar from its git remote so the sidebar shows the
// same picture as the add-project picker. github.com/<owner>.png serves the
// owner avatar without auth; non-GitHub or detached repos resolve to null.
ipcMain.handle(
  "gh:repo-avatar",
  async (_evt, opts: { rootPath: string; remoteName?: string }) => {
    try {
      // The repo root belongs to the daemon's filesystem when a remote is
      // configured; `git -C` here would fail with a confusing chdir error.
      if (loadRemoteConfig()) return { ok: true, avatarUrl: "" };
      const remote = opts.remoteName?.trim() || "origin";
      const { stdout } = await execFileP(
        "git",
        ["-C", opts.rootPath, "remote", "get-url", remote],
        { env: spawnEnv(), maxBuffer: 1024 * 1024 },
      );
      const owner = stdout.trim().match(/github\.com[:/]+([^/]+)\//i)?.[1];
      if (!owner) return { ok: true, avatarUrl: "" };
      return { ok: true, avatarUrl: `https://github.com/${owner}.png?size=64` };
    } catch (err) {
      logLine("error", `repo avatar resolve failed: ${(err as Error).message}`);
      return { ok: false, error: (err as Error).message };
    }
  },
);

// List open issues + PRs for a repo (for the New workspace → Github tab). Runs
// gh inside the repo's working tree so it resolves the right owner/name; only
// open items are returned.
ipcMain.handle(
  "gh:list-work",
  async (_evt, opts: { rootPath: string }) => {
    const run = async (kind: "issue" | "pr", extra: string[]) => {
      const { stdout } = await execFileP(
        "gh",
        [kind, "list", "--state", "open", "--limit", "100", "--json", ["number", "title", "updatedAt", "author", ...extra].join(",")],
        { cwd: opts.rootPath, env: spawnEnv(), maxBuffer: 16 * 1024 * 1024 },
      );
      const raw = JSON.parse(stdout) as {
        number: number;
        title: string;
        updatedAt: string;
        author?: { login?: string };
      }[];
      return raw.map((r) => ({
        kind,
        number: r.number,
        title: r.title,
        updatedAt: r.updatedAt,
        author: r.author?.login ?? "",
      }));
    };
    // `gh` resolves the repo from its working directory, which lives on the
    // daemon's machine when a remote is configured. There is no daemon-side RPC
    // for this listing yet, so say why instead of failing on a missing cwd.
    const blocked = remoteHandlerBlock(loadRemoteConfig(), "Listing GitHub issues and pull requests");
    if (blocked) return blocked;
    try {
      const [issues, prs] = await Promise.all([run("issue", []), run("pr", ["headRefName"])]);
      const items = [...prs, ...issues].sort((a, b) =>
        (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""),
      );
      return { ok: true, items };
    } catch (err) {
      logLine("error", `gh list work failed: ${(err as Error).message}`);
      return { ok: false, error: (err as Error).message };
    }
  },
);

// Check whether a filesystem path exists (used to prune repositories whose root
// directory was deleted on disk). While a remote daemon owns the workspaces the
// path lives on its machine, so this process cannot judge it — answer "exists"
// rather than reporting every remote repository as deleted.
ipcMain.handle("fs:path-exists", async (_evt, p: string) => {
  try {
    if (loadRemoteConfig()) return { exists: true, remote: true };
    return { exists: !!p && fs.existsSync(p) };
  } catch {
    return { exists: false };
  }
});

// Open a URL in the default browser or a path in the OS default handler
// (editor/file manager). Used by the PR status bar, the top-bar editor button,
// and every link clicked in rendered agent markdown. Rejects schemes outside
// http(s)/mailto and missing paths to avoid launching junk.
ipcMain.handle("shell:open-external", async (_evt, target: string) => {
  try {
    if (isExternalOpenTarget(target)) {
      await shell.openExternal(target);
      return { ok: true };
    }
    // http(s)/mailto targets are machine-independent and handled above; a bare
    // path is only openable when this machine holds the files.
    const blocked = remoteHandlerBlock(loadRemoteConfig(), "Opening this path");
    if (blocked) return blocked;
    if (target && fs.existsSync(target)) {
      const err = await shell.openPath(target);
      return err ? { ok: false, error: err } : { ok: true };
    }
    return { ok: false, error: "invalid target" };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
});

const WORKSPACE_APP_COMMANDS: Record<string, string> = {
  cursor: "cursor",
  vscode: "code",
};

ipcMain.handle("shell:open-workspace-app", async (_evt, opts: { rootPath?: string; appId?: string }) => {
  const rootPath = opts?.rootPath;
  const appId = opts?.appId;
  const command = appId ? WORKSPACE_APP_COMMANDS[appId] : undefined;
  const blocked = remoteHandlerBlock(loadRemoteConfig(), "Opening the workspace in an editor");
  if (blocked) return blocked;
  if (!rootPath || !fs.existsSync(rootPath) || !command) {
    return { ok: false, error: "invalid workspace app target" };
  }
  return await new Promise<{ ok: boolean; error?: string }>((resolve) => {
    const child = spawn(command, [rootPath], {
      cwd: rootPath,
      detached: true,
      stdio: "ignore",
      env: { ...process.env, PATH: shellPath() },
    });
    child.once("error", (err) => resolve({ ok: false, error: err.message }));
    child.once("spawn", () => {
      child.unref();
      resolve({ ok: true });
    });
  });
});

ipcMain.handle("app:check-for-updates", async () => {
  const currentVersion = app.getVersion();
  try {
    const response = await fetch("https://api.github.com/repos/perceo-ai/conductor-arch/releases/latest", {
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": `Archductor/${currentVersion}`,
      },
    });
    if (!response.ok) {
      return { ok: false, currentVersion, error: `GitHub returned ${response.status}` };
    }
    const release = (await response.json()) as {
      tag_name?: string;
      html_url?: string;
    };
    const latestVersion = release.tag_name?.trim();
    if (!latestVersion) return { ok: false, currentVersion, error: "latest release has no tag" };
    return {
      ok: true,
      currentVersion,
      latestVersion,
      updateAvailable: compareVersions(latestVersion, currentVersion) > 0,
      releaseUrl: release.html_url,
    };
  } catch (err) {
    logLine("error", `update check failed: ${(err as Error).message}`);
    return { ok: false, currentVersion, error: (err as Error).message };
  }
});

ipcMain.on("window:minimize", () => win?.minimize());
ipcMain.on("window:toggle-maximize", () => {
  if (!win) return;
  win.isMaximized() ? win.unmaximize() : win.maximize();
});
ipcMain.on("window:close", () => win?.close());

app.whenReady().then(createWindow);

app.on("window-all-closed", () => {
  bridge.close();
  logStream?.end();
  logStream = null;
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
