import { app, BrowserWindow, ipcMain } from "electron";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// A fixture that behaves like a development build of a real app, which the minimal fixture next to it does not:
// an ESM main process, two windows, DevTools opened at startup, a noisy console, a page with thousands of nodes and
// a button the user has to press before anything happens. The runner drives faults through the parent IPC channel.
const here = path.dirname(fileURLToPath(import.meta.url));
const run = process.env.FIELD_RUN_ID ?? "";
// The fault comes from the environment, or from a `.fault` file next to the app when a runner prepared a copy for a host
// to start itself (an environment variable there would be visible to the host and could be unset by it).
const faultFile = (() => { try { return readFileSync(path.join(here, ".fault"), "utf8").trim(); } catch { return ""; } })();
const fault = process.env.FIELD_FAULT ?? faultFile;
const noise = process.env.FIELD_NOISE ?? "800";
const openDevTools = process.env.FIELD_DEVTOOLS !== "false";
if (process.env.FIELD_RENDERER_PORT) {
  app.commandLine.appendSwitch("remote-debugging-port", process.env.FIELD_RENDERER_PORT);
}

// Fault "stale": the first save fails, as it did before the developer fixed the handler; later saves work.
let saves = 0;
ipcMain.handle("field:save", async (_event, payload) => {
  saves += 1;
  console.log("FIELD_SAVE_REQUEST", run, payload?.name ?? "");
  if (fault === "save" || (fault === "stale" && saves === 1)) {
    console.error("FIELD_SAVE_HANDLER_FAILURE");
    throw new Error("field save handler failure");
  }
  return { saved: true };
});

// Fault "sync-mismatch": the renderer sends `field:sync-now`, but the main process listens on another name. Nothing is
// thrown or logged anywhere; only the IPC trace shows that the message had no listener.
ipcMain.on(fault === "sync-mismatch" ? "field:sync-start" : "field:sync-now", () => {
  console.log("FIELD_SYNC_STARTED", run);
});

function createWindow(file, bounds) {
  const window = new BrowserWindow({
    ...bounds,
    webPreferences: { contextIsolation: true, nodeIntegration: false, preload: path.join(here, "preload.cjs") },
  });
  void window.loadFile(path.join(here, file), { query: { run, noise, fault } });
  return window;
}

let mainWindow;
app.whenReady().then(() => {
  mainWindow = createWindow("index.html", { width: 900, height: 650, x: 40, y: 40 });
  createWindow("settings.html", { width: 480, height: 360, x: 980, y: 40 });
  // Dev builds usually open DevTools next to the window under test.
  if (openDevTools) mainWindow.webContents.openDevTools({ mode: "detach" });
});

// Runner-only controls over the parent IPC channel, never exposed by MCP.
process.on("message", async ({ id, command }) => {
  try {
    if (command === "quit") {
      (await import("node:inspector")).close();
      app.exit(0);
      return;
    }
    if (command === "exit") {
      // A hard exit with a recognisable code, as when a main-process bug brings the app down.
      app.exit(3);
      return;
    }
    await app.whenReady();
    if (command === "crash-renderer") {
      mainWindow.webContents.forcefullyCrashRenderer();
    } else if (command === "reload") {
      const loaded = new Promise((resolve) => mainWindow.webContents.once("did-finish-load", resolve));
      mainWindow.webContents.reload();
      await loaded;
    } else {
      throw new Error(`unknown field command: ${command}`);
    }
    process.send?.({ id, ok: true });
  } catch (error) {
    process.send?.({ id, ok: false, error: String(error) });
  }
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
