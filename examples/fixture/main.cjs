const { app, BrowserWindow, ipcMain, utilityProcess } = require("electron");
const path = require("node:path");

const fault = process.env.FIXTURE_FAULT || "";
const run = process.env.FIXTURE_RUN_ID || "";
let currentWindow;
if (process.env.FIXTURE_RENDERER_PORT) {
  app.commandLine.appendSwitch("remote-debugging-port", process.env.FIXTURE_RENDERER_PORT);
}
if (process.env.FIXTURE_DEBUG === "true") {
  console.error("FIXTURE_RENDERER_PORT", app.commandLine.getSwitchValue("remote-debugging-port"));
}

ipcMain.handle("fixture:get-value", async () => {
  if (fault === "ipc") {
    console.error("FIXTURE_IPC_HANDLER_FAILURE");
    throw new Error("fixture IPC handler failure");
  }
  return "fixture-ok";
});

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

  currentWindow = window;
  void window.loadFile(path.join(__dirname, "index.html"), {
    query: { fault, run },
  });
  return window;
}

// Fixture-only controls over the test runner's parent IPC channel, never exposed by MCP.
process.on("message", async ({ id, command }) => {
  try {
    if (command === "quit") {
      require("node:inspector").close();
      app.exit(0);
      return;
    }
    await app.whenReady();
    if (command === "reload") {
      const loaded = new Promise((resolve) => currentWindow.webContents.once("did-finish-load", resolve));
      currentWindow.webContents.reload();
      await loaded;
    } else if (command === "recreate") {
      const old = currentWindow;
      const replacement = createWindow();
      await new Promise((resolve) => replacement.webContents.once("did-finish-load", resolve));
      old.destroy();
    } else if (command === "evidence") {
      console.log("FIXTURE_MAIN_LIFECYCLE", run, id);
    } else {
      throw new Error(`unknown fixture command: ${command}`);
    }
    process.send?.({ id, ok: true });
  } catch (error) {
    process.send?.({ id, ok: false, error: String(error) });
  }
});

app.whenReady().then(() => {
  if (process.env.FIXTURE_UTILITY === "true") {
    // --inspect-port only chooses the port; the inspector stays closed until something opens it.
    const port = process.env.FIXTURE_UTILITY_PORT;
    utilityProcess.fork(path.join(__dirname, "utility.cjs"), [], {
      serviceName: "fixture-utility",
      execArgv: port ? [`--inspect-port=${port}`] : [],
      stdio: "inherit",
    });
  }
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
