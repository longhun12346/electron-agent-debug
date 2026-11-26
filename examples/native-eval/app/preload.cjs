const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("nativeEval", {
  sumSizes: (dir) => ipcRenderer.invoke("native:sum-sizes", dir),
  hasSubdir: (root, name) => ipcRenderer.invoke("native:has-subdir", root, name),
  slots: () => ipcRenderer.invoke("native:slots"),
});
