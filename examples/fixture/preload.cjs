const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("fixtureApi", {
  getValue: () => ipcRenderer.invoke("fixture:get-value"),
});

// Test-only: lets the smokes send each kind of IPC message on any fixture: channel, so IPC tracing can be checked.
const fixtureChannel = (channel) => {
  if (typeof channel !== "string" || !channel.startsWith("fixture:")) throw new Error("fixture channels only");
  return channel;
};
contextBridge.exposeInMainWorld("fixtureIpc", {
  invoke: (channel, ...args) => ipcRenderer.invoke(fixtureChannel(channel), ...args),
  send: (channel, ...args) => ipcRenderer.send(fixtureChannel(channel), ...args),
  sendSync: (channel, ...args) => ipcRenderer.sendSync(fixtureChannel(channel), ...args),
});
