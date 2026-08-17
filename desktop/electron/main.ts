import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { ArchcarBridge, loadRemoteConfig, remoteProfilePath } from "./archcar.js";
import { parseGithubRepos } from "./githubRepos.js";
import { resolveWindowIconPath } from "./icon.js";

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
    // Keep the previous profile so a typo doesn't destroy a working remote
    // connection — restore it if the new daemon is unreachable.
    let previous: string | null = null;
    try {
      previous = fs.readFileSync(remoteProfilePath(), "utf8");
    } catch {
      previous = null;
    }
    const restore = () => {
      if (previous === null) fs.rmSync(remoteProfilePath(), { force: true });
      else fs.writeFileSync(remoteProfilePath(), previous, { mode: 0o600 });
    };
    try {
      // Persist, then verify through the bridge (it re-reads the profile per
      // connection).
      fs.mkdirSync(path.dirname(remoteProfilePath()), { recursive: true });
      fs.writeFileSync(remoteProfilePath(), JSON.stringify({ address, token }, null, 2) + "\n", {
        mode: 0o600,
      });
      const res = await bridge.request<{ type: string }, { type: string; message?: string }>({
        type: "get_remote_access",
      });
      if (res.type === "error") {
        restore();
        return { ok: false, error: res.message ?? "remote daemon refused the connection" };
      }
      logLine("remote", `connected to archcar at ${address}`);
      // Drop the local event stream; the auto-reconnect resubscribes against
      // the new endpoint because open() re-reads the profile.
      bridge.close();
      return { ok: true, address };
    } catch (err) {
      restore();
      return { ok: false, error: (err as Error).message };
    }
  },
);

ipcMain.handle("archcar:remote-clear", async () => {
  try {
    fs.rmSync(remoteProfilePath(), { force: true });
    logLine("remote", "cleared remote profile; using the local daemon");
    bridge.close();
    return { ok: true };
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
// directory was deleted on disk).
ipcMain.handle("fs:path-exists", async (_evt, p: string) => {
  try {
    return { exists: !!p && fs.existsSync(p) };
  } catch {
    return { exists: false };
  }
});

// Open a URL in the default browser or a path in the OS default handler
// (editor/file manager). Used by the PR status bar and the top-bar editor
// button. Rejects non-http(s) URLs and missing paths to avoid launching junk.
ipcMain.handle("shell:open-external", async (_evt, target: string) => {
  try {
    if (/^https?:\/\//i.test(target)) {
      await shell.openExternal(target);
      return { ok: true };
    }
    if (target && fs.existsSync(target)) {
      const err = await shell.openPath(target);
      return err ? { ok: false, error: err } : { ok: true };
    }
    return { ok: false, error: "invalid target" };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
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
