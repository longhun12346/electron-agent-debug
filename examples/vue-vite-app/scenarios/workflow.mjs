import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { appRoot, taskCount, waitUntil, withSession } from "../support.mjs";

// Day-to-day development: the dev server, a route change, a hot update, a main-process edit, and the built app.
export const scenarios = {};

scenarios.healthy = () => withSession({}, async (s) => {
  const attached = await s.attach({ instrument: ["ipc"] });
  assert.ok(attached.main.online && attached.renderer.online, JSON.stringify(attached));
  await s.renderer(taskCount(2));
  assert.equal(await s.evaluate("renderer", "location.origin.startsWith('http://localhost')"), true, "served by the dev server");
  const snapshot = await s.call("electron_dom_snapshot", {});
  assert.match(snapshot.text, /Review the pull request/u);
  assert.match(snapshot.text, /1 open of 2/u);

  // Add a task through the real form; the round trip goes renderer, preload, ipcMain, the JSON file and back.
  await s.call("electron_type", { role: "textbox", name: "New task", text: "Ship the demo" });
  const added = await s.call("electron_click", { role: "button", name: "Add" });
  await s.renderer(taskCount(3));
  const stored = await s.evaluate("main", `JSON.parse(process.getBuiltinModule('node:fs').readFileSync(
    process.getBuiltinModule('node:path').join(${JSON.stringify(s.app.dataDir)}, 'tasks.json'), 'utf8')).map((task) => task.title)`);
  assert.deepEqual(stored, ["Write the release notes", "Review the pull request", "Ship the demo"]);
  const afterAdd = (await s.logs({ afterSeq: added.afterSeq })).filter((event) => event.kind === "ipc");
  assert.ok(afterAdd.some((event) => event.data?.channel === "tasks:add" && event.data?.type === "invoke" && event.data?.ok === true),
    `the add round trip is traced: ${JSON.stringify(afterAdd)}`);

  // A file's bytes go over IPC as an argument: the trace sizes it by its length instead of serializing it.
  const imported = await s.evaluate("renderer", `(async () => {
    const payload = new TextEncoder().encode('["Imported one"]' + ' '.repeat(200000));
    return { length: payload.length, count: (await window.api.importTasks(payload)).length };
  })()`);
  assert.equal(imported.count, 4);
  const importEvent = await s.eventAfter(added.afterSeq, "main", "IPC invoke tasks:import");
  assert.equal(importEvent?.data?.argBytes, imported.length, JSON.stringify(importEvent));

  // The search box asks the main process, which asks the indexer utility process.
  await s.call("electron_type", { role: "searchbox", name: "Search tasks", text: "demo" });
  await s.renderer(taskCount(1));
  assert.match(await s.evaluate("renderer", "document.querySelector('li.task').textContent"), /Ship the demo/u);

  // Router: a client-side navigation does not reload the page. The theme is read with a synchronous IPC call.
  await s.evaluate("renderer", "window.__survives = 'yes'; true");
  const navigated = await s.call("electron_click", { role: "link", name: "Settings" });
  await s.renderer("location.hash === '#/settings' && document.body.innerText.includes('App version')");
  assert.equal(await s.evaluate("renderer", "window.__survives"), "yes");
  const sync = (await s.logs({ afterSeq: navigated.afterSeq })).find((event) => event.kind === "ipc" && event.data?.channel === "theme:get");
  assert.equal(sync?.data?.type, "sendSync", `the synchronous theme read is traced: ${JSON.stringify(sync)}`);
});

// Vite swaps a changed component in place; the page, the Pinia state and the marker on window all stay.
scenarios.hmr = () => withSession({}, async (s) => {
  const board = path.join(appRoot, "src/renderer/src/views/TaskBoard.vue");
  const original = readFileSync(board, "utf8");
  try {
    await s.attach({ instrument: ["ipc"] });
    await s.renderer(taskCount(2));
    await s.evaluate("renderer", "window.__survives = 'yes'; true");
    writeFileSync(board, original.replace("<h1>Tasks</h1>", "<h1>Tasks (edited)</h1>"));
    await s.renderer("document.querySelector('h1')?.textContent === 'Tasks (edited)'", 30_000);
    assert.equal(await s.evaluate("renderer", "window.__survives"), "yes", "hot update must not reload the page");
    assert.equal(await s.evaluate("renderer", "document.querySelectorAll('li.task').length"), 2, "list state survives");
  } finally {
    writeFileSync(board, original);
  }
});

// A main-process change makes electron-vite restart Electron on the same ports; the tools attach again and see new state.
scenarios["main-restart"] = () => withSession({}, async (first) => {
  let s = first;
  const entry = path.join(appRoot, "src/main/index.ts");
  const original = readFileSync(entry, "utf8");
  try {
    await s.attach();
    await s.renderer(taskCount(2));
    const firstPid = await s.evaluate("main", "process.pid");
    // On macOS electron-vite stops Electron gracefully, and Node keeps a process with a debugger attached alive until the
    // debugger lets go. The old process then still holds the inspector port ("address already in use") and the new one
    // starts without an inspector, so the tools disconnect first there and a new session attaches afterwards.
    if (process.platform === "darwin") {
      await s.client.close();
      s = await s.newSession({});
    }
    const editedAt = new Date().toISOString();
    writeFileSync(entry, `${original}\nconsole.log("main restarted by the smoke test");\n`);
    const secondPid = await waitUntil(async () => {
      try {
        const attached = await s.attach();
        if (!attached.main.online || !attached.renderer.online) return undefined;
        return await s.evaluate("main", "process.pid");
      } catch { return undefined; }
    }, (pid) => pid !== undefined && pid !== firstPid, "Electron restarted by electron-vite", 60_000);
    assert.notEqual(secondPid, firstPid);
    await s.renderer(taskCount(2));
    // Anything the new process logged before the tools attached again is not replayed, so the evidence starts at the new
    // connection; the old process's events must not be mixed into it.
    const fresh = await s.logs({ sinceAttach: true });
    assert.ok(fresh.every((event) => event.observedAt >= editedAt), `events from before the restart: ${JSON.stringify(fresh)}`);
  } finally {
    writeFileSync(entry, original);
  }
});

scenarios.built = () => withSession({ built: true }, async (s) => {
  const attached = await s.attach({ instrument: ["ipc"] });
  assert.ok(attached.main.online && attached.renderer.online, JSON.stringify(attached));
  await s.renderer(taskCount(2));
  assert.equal(await s.evaluate("renderer", "location.protocol"), "file:", "loaded from the build output, not the dev server");
  await s.call("electron_click", { role: "link", name: "Settings" });
  await s.renderer("location.hash === '#/settings' && document.body.innerText.includes('App version')");
  assert.equal(await s.electron("return electron.app.isPackaged"), false);
});
