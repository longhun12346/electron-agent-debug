import { contextBridge, ipcRenderer } from "electron";

const api = {
  info: () => ipcRenderer.invoke("app:info"),
  listTasks: () => ipcRenderer.invoke("tasks:list"),
  addTask: (title: string) => ipcRenderer.invoke("tasks:add", title),
  toggleTask: (id: string) => ipcRenderer.invoke("tasks:toggle", id),
  removeTask: (id: string) => ipcRenderer.invoke("tasks:remove", id),
  importTasks: (bytes: Uint8Array) => ipcRenderer.invoke("tasks:import", bytes),
  searchTasks: (query: string) => ipcRenderer.invoke("tasks:search", query),
  startSync: () => ipcRenderer.send("sync:start"),
  onSyncDone: (callback: (payload: { at: string }) => void) => {
    const listener = (_event: unknown, payload: { at: string }) => callback(payload);
    ipcRenderer.on("sync:done", listener);
    return () => ipcRenderer.removeListener("sync:done", listener);
  },
  getTheme: (): string => ipcRenderer.sendSync("theme:get"),
  setTheme: (value: string) => ipcRenderer.send("theme:set", value),
  openSettingsWindow: () => ipcRenderer.invoke("window:open-settings"),
};

contextBridge.exposeInMainWorld("api", api);
