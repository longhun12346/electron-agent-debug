const { app, BrowserWindow, ipcMain } = require("electron");
const path = require("node:path");
const koffi = require("koffi");

const libraryName = { win32: "native_eval.dll", darwin: "libnative_eval.dylib" }[process.platform] ?? "libnative_eval.so";
const dll = process.env.NATIVE_EVAL_DLL || path.join(__dirname, "..", "native", "build", libraryName);
const lib = koffi.load(dll);
const sumSizes = lib.func("int64_t sum_sizes(const char *dir)");
const hasSubdir = lib.func("int has_subdir(const char *root, const char *name)");
const initSlots = lib.func("int init_slots(int requested)");
const labelLength = lib.func("int label_length(const char *label)");

// Runs once at startup, before any window exists.
const requested = Number(process.env.NATIVE_EVAL_SLOTS || 200);
const slots = initSlots(requested);
console.log(`worker slots: ${slots} (requested ${requested})`);

ipcMain.handle("native:sum-sizes", (_event, dir) => Number(sumSizes(dir)));
ipcMain.handle("native:has-subdir", (_event, root, name) => hasSubdir(root, name) === 1);
ipcMain.handle("native:slots", () => slots);
ipcMain.handle("native:label-length", (_event, label) => labelLength(label));

// Optional C++ N-API (.node) addon built by native/build-napi.{bat,sh}.
let napiAddon = null;
try {
  napiAddon = require(process.env.NATIVE_EVAL_NAPI || path.join(__dirname, "..", "native", "build", "napi_addon.node"));
} catch {
  // Built on demand via build-napi.{bat,sh}.
}
ipcMain.handle("native:napi-clamp-slots", (_event, value) => {
  if (!napiAddon) throw new Error("napi_addon.node not built; run native/build-napi.bat or build-napi.sh");
  return napiAddon.clampSlots(value);
});

app.whenReady().then(() => {
  const win = new BrowserWindow({
    width: 640,
    height: 420,
    webPreferences: { preload: path.join(__dirname, "preload.cjs") },
  });
  win.loadFile(path.join(__dirname, "index.html"));
});

app.on("window-all-closed", () => app.quit());
