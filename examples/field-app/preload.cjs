"use strict";
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("fieldApi", {
  save: (payload) => ipcRenderer.invoke("field:save", payload),
});
