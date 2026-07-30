import { app, BrowserWindow, ipcMain } from "electron";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { ArchcarBridge } from "./archcar.js";

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

  win.on("focus", () => win?.webContents.send("window:focus", true));
  win.on("blur", () => win?.webContents.send("window:focus", false));

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
    win?.webContents.send("archcar:event", event);
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

// Window controls for the custom (frameless) chrome.
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
