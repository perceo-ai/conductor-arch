import { app, BrowserWindow, ipcMain } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ArchcarBridge } from "./archcar.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      // Sandboxed renderer; the preload only require()s electron
      // (contextBridge/ipcRenderer), which sandboxed preloads may use.
      sandbox: true,
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

// One-shot request/response.
ipcMain.handle("archcar:request", async (_evt, payload: unknown) => {
  try {
    const res = await bridge.request(payload as never);
    return { ok: true, value: res };
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
  const forward = (event: unknown) => win?.webContents.send("archcar:event", event);
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
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
