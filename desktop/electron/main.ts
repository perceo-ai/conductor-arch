import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { ArchcarBridge } from "./archcar.js";

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
  win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: "#191919",
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
    const raw = JSON.parse(stdout) as {
      full_name: string;
      name: string;
      ssh_url: string;
      html_url: string;
      pushed_at: string;
      owner: { login: string; avatar_url: string };
    }[];
    // Most-recently-pushed first — matches how people think about "recent" repos.
    raw.sort((a, b) => (b.pushed_at ?? "").localeCompare(a.pushed_at ?? ""));
    const repos = raw.slice(0, 300).map((r) => ({
      nameWithOwner: r.full_name,
      name: r.name,
      sshUrl: r.ssh_url,
      url: r.html_url,
      pushedAt: r.pushed_at,
      owner: r.owner?.login ?? "",
      avatarUrl: r.owner?.avatar_url ? `${r.owner.avatar_url}&s=64` : "",
    }));
    return { ok: true, repos };
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
