import { app, BrowserWindow, ipcMain, shell, utilityProcess } from "electron";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { TaskStore } from "./tasks";

// APP_DATA_DIR keeps test runs out of the real profile. APP_FAULT switches on one of the bugs the debugging tests look for.
const fault = process.env.APP_FAULT ?? "";
// A dev console that is noisy before anyone attaches, as it is with hot updates streaming in.
const noise = Number(process.env.APP_NOISE ?? 0);
if (process.env.APP_DATA_DIR) app.setPath("userData", process.env.APP_DATA_DIR);

const store = new TaskStore(join(app.getPath("userData"), "tasks.json"));
let theme = "light";

// The search index runs in its own utility process.
let indexer: Electron.UtilityProcess | undefined;
let searchId = 0;
const searches = new Map<number, (ids: string[]) => void>();

function startIndexer(): void {
  const inspectPort = process.env.APP_INDEXER_INSPECT_PORT;
  indexer = utilityProcess.fork(join(__dirname, "indexer.js"), [], {
    serviceName: "task-indexer",
    execArgv: inspectPort ? [`--inspect-port=${inspectPort}`] : [],
    stdio: "inherit",
  });
  indexer.on("message", ({ id, ids }: { id: number; ids: string[] }) => {
    searches.get(id)?.(ids);
    searches.delete(id);
  });
}

function reindex(): void {
  try {
    indexer?.postMessage({ type: "index", entries: store.list().map(({ id, title }) => ({ id, title })) });
  } catch (error) {
    console.error("indexer: could not read the tasks", error);
  }
}

function search(query: string): Promise<string[]> {
  return new Promise((resolve) => {
    const id = ++searchId;
    searches.set(id, resolve);
    indexer?.postMessage({ type: "search", id, query });
  });
}

let adds = 0;

function registerIpc(): void {
  ipcMain.handle("app:info", () => ({ version: app.getVersion(), platform: process.platform, electron: process.versions.electron, noise }));
  ipcMain.handle("tasks:list", () => store.list());
  // FAULT ipc-channel: the handler is registered under another name than the one the preload calls.
  ipcMain.handle(fault === "ipc-channel" ? "tasks:create" : "tasks:add", (_event, title: string) => {
    // FAULT stale-add: the first save fails, as it did before the developer fixed the handler; later saves work.
    adds += 1;
    if (fault === "stale-add" && adds === 1) {
      console.error("tasks:add failed: disk full");
      throw new Error("disk full");
    }
    // FAULT missing-field: new tasks come back without the assignee the task list renders.
    const task = store.add(title, fault !== "missing-field");
    reindex();
    return task;
  });
  ipcMain.handle("tasks:toggle", (_event, id: string) => store.toggle(id));
  ipcMain.handle("tasks:remove", (_event, id: string) => {
    const tasks = store.remove(id);
    reindex();
    return tasks;
  });
  // Tasks come in as the bytes of a JSON file: ["title", ...].
  ipcMain.handle("tasks:import", (_event, bytes: Uint8Array) => {
    const titles = JSON.parse(Buffer.from(bytes).toString("utf8")) as string[];
    for (const title of titles) store.add(title, fault !== "missing-field");
    reindex();
    return store.list();
  });
  ipcMain.handle("tasks:search", (_event, query: string) => (query.trim() ? search(query) : null));

  // FAULT silent-send: main listens on a different channel than the one the preload sends to; nothing is reported.
  ipcMain.on(fault === "silent-send" ? "sync-start" : "sync:start", (event) => {
    setTimeout(() => event.sender.send("sync:done", { at: new Date().toISOString() }), 150);
  });

  // The theme is read synchronously when the settings page opens.
  ipcMain.on("theme:get", (event) => { event.returnValue = theme; });
  ipcMain.on("theme:set", (_event, value: string) => { theme = value; });

  ipcMain.handle("window:open-settings", () => createWindow({ hash: "/settings", width: 520, height: 420 }));
}

// The window comes back at the size it was closed at. A damaged window.json makes this throw, and no window is created.
function savedSize(): { width?: number; height?: number } {
  try {
    return JSON.parse(readFileSync(join(app.getPath("userData"), "window.json"), "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
}

function createWindow({ hash = "/", width = 960, height = 640 } = {}): BrowserWindow {
  const saved = hash === "/" ? savedSize() : {};
  const window = new BrowserWindow({
    width: saved.width ?? width,
    height: saved.height ?? height,
    show: false,
    webPreferences: {
      // FAULT preload-path: the preload script is not where the code looks for it, so window.api never exists.
      preload: join(__dirname, fault === "preload-path" ? "../preload/index.mjs" : "../preload/index.js"),
    },
  });
  window.on("ready-to-show", () => window.show());
  window.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: "deny" };
  });
  if (!app.isPackaged && process.env["ELECTRON_RENDERER_URL"]) {
    void window.loadURL(`${process.env["ELECTRON_RENDERER_URL"]}#${hash}`);
  } else {
    void window.loadFile(join(__dirname, "../renderer/index.html"), { hash });
  }
  return window;
}

app.whenReady().then(() => {
  registerIpc();
  startIndexer();
  reindex();
  try {
    const main = createWindow();
    // Dev builds usually open DevTools next to the window, and restore the windows of the last session.
    if (process.env.APP_DEVTOOLS === "true") main.webContents.openDevTools({ mode: "detach" });
    if (process.env.APP_OPEN_SETTINGS === "true") createWindow({ hash: "/settings", width: 520, height: 420 });
  } catch (error) {
    console.error("Could not create the main window", error);
  }
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
