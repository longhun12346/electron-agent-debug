const { app, BrowserWindow, ipcMain } = require("electron");
const path = require("node:path");

const fault = process.env.FIXTURE_FAULT || "";
if (process.env.FIXTURE_RENDERER_PORT) {
  app.commandLine.appendSwitch("remote-debugging-port", process.env.FIXTURE_RENDERER_PORT);
}
if (process.env.FIXTURE_DEBUG === "true") {
  console.error("FIXTURE_RENDERER_PORT", app.commandLine.getSwitchValue("remote-debugging-port"));
}

function createWindow() {
  if (fault === "main-window") {
    console.error("FIXTURE_MAIN_WINDOW_FAILURE");
    throw new Error("fixture main window creation failure");
  }

  const window = new BrowserWindow({
    width: 900,
    height: 650,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, "preload.cjs"),
    },
  });

  ipcMain.handle("fixture:get-value", async () => {
    if (fault === "ipc") {
      console.error("FIXTURE_IPC_HANDLER_FAILURE");
      throw new Error("fixture IPC handler failure");
    }
    return "fixture-ok";
  });

  void window.loadFile(path.join(__dirname, "index.html"), {
    query: { fault },
  });
}

app.whenReady().then(() => {
  try {
    createWindow();
  } catch (error) {
    console.error("FIXTURE_MAIN_FAILURE", error);
  }
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
