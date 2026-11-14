const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("fixtureApi", {
  getValue: () => ipcRenderer.invoke("fixture:get-value"),
});
