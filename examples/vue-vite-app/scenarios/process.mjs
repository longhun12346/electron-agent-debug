import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { discovery, freePort, taskCount, waitUntil, withSession } from "../support.mjs";

// What happens around the app rather than inside one page: a utility process, several windows and DevTools, a noisy
// console, a crashed page, an app that exits, one that is restarted, and an attach with nothing to attach to.
export const scenarios = {};
const codes = (result) => result.errors.map((error) => error.code);

// Attaching to the search index process, which was forked without an open inspector.
scenarios.utility = async () => {
  const indexerPort = await freePort();
  await withSession({ built: true, indexerPort }, async (s) => {
    assert.equal(await discovery(indexerPort), undefined, "the utility inspector must start closed");
    const base = await s.attach();
    assert.ok(base.main.online && base.renderer.online, JSON.stringify(base));

    // An unknown name lists the candidates; poll it until the forked process is registered.
    const missing = await waitUntil(
      () => s.call("electron_attach", { utility: "no-such-process" }),
      (result) => result.errors[0]?.details?.candidates?.some((item) => item.name === "task-indexer"),
      "utility process registration",
    );
    assert.deepEqual(codes(missing), ["UTILITY_NOT_FOUND"]);
    assert.equal(missing.utility.online, false);
    assert.ok(missing.main.online && missing.renderer.online, JSON.stringify(missing));

    // With evaluation switched off by the host, the inspector is not opened at all.
    const disabled = await s.newSession({ ELECTRON_DEBUG_ALLOW_EVAL: "0" });
    const refused = await disabled.call("electron_attach", { mainUrl: s.app.mainUrl, rendererUrl: s.app.rendererUrl, utility: "task-indexer" });
    assert.deepEqual(codes(refused), ["EVALUATION_NOT_ALLOWED"]);
    assert.equal(refused.utility.online, false);
    assert.equal(await discovery(indexerPort), undefined, "a refused attach must not open the inspector");

    const attached = await s.call("electron_attach", { utility: "task-indexer" });
    assert.deepEqual(attached.errors, [], JSON.stringify(attached));
    assert.ok(attached.utility.online && attached.main.online && attached.renderer.online, JSON.stringify(attached));
    const pid = Number(attached.utility.selectedTarget.id);
    assert.equal(attached.utility.selectedTarget.title, "task-indexer");
    assert.equal(attached.utility.endpoint, `http://127.0.0.1:${indexerPort}`);

    assert.equal(await s.evaluate("utility", "process.type"), "utility");
    assert.equal(await s.evaluate("utility", "process.pid"), pid);
    assert.equal(await s.evaluate("utility", "indexer.size()"), 2, "the two seeded tasks are indexed");
    assert.equal(await s.evaluate("main", "process.type"), "browser");

    // Its own console is attributed to it, not to the main process.
    const { lastSeq } = await s.call("electron_logs", { process: "utility" });
    const marker = randomUUID();
    assert.equal(await s.evaluate("utility", `console.log('indexer-marker ${marker}'); true`), true);
    const waited = await s.call("electron_wait_for", { log: { contains: marker, process: "utility", afterSeq: lastSeq }, timeoutMs: 5_000 });
    assert.equal(waited.event.process, "utility");
    const mainLogs = await s.call("electron_logs", { process: "main", limit: 10_000 });
    assert.ok(!mainLogs.events.some((event) => event.message.includes(marker)), "utility output must not be attributed to main");

    // A real change reaches it: a task added in the page is indexed.
    await s.call("electron_type", { role: "textbox", name: "New task", text: "Index me" });
    await s.call("electron_click", { role: "button", name: "Add" });
    await waitUntil(() => s.evaluate("utility", "indexer.size()"), (size) => size === 3, "the new task reaches the indexer");

    const byPid = await s.call("electron_attach", { utility: pid });
    assert.deepEqual(byPid.errors, [], JSON.stringify(byPid));
    assert.ok(byPid.utility.online && byPid.main.online && byPid.renderer.online, JSON.stringify(byPid));
  });
};

// Two windows plus DevTools, and a console that was noisy before anyone attached.
scenarios.windows = () => withSession({ built: true, noise: 800, env: { APP_DEVTOOLS: "true", APP_OPEN_SETTINGS: "true" } }, async (s) => {
  // Two real windows plus DevTools: the tool cannot guess, and must say it is two windows, not three.
  const attached = await waitUntil(() => s.attach(), (result) => ["Task Board", "Settings - Task Board"].every((title) => result.targets?.some((target) => target.title === title)) && result.targets.some((target) => target.url.startsWith("devtools://")), "both windows (with their titles) and DevTools listed");
  assert.equal(attached.main.online, true);
  assert.equal(attached.renderer.online, false);
  const selection = attached.errors.find((error) => error.code === "TARGET_SELECTION_REQUIRED");
  assert.ok(selection, JSON.stringify(attached.errors));
  assert.equal(selection.details.count, 2, "DevTools must not count as a window to choose from");
  assert.equal(attached.targets.filter((target) => target.url.startsWith("devtools://")).length, 1);

  // Choosing by title is how an agent recovers.
  const chosen = await s.call("electron_targets", { title: "Task Board" });
  assert.equal(chosen.selectedTarget.title, "Task Board");
  assert.equal((await s.call("electron_status")).renderer.online, true);
  assert.equal(await s.evaluate("main", "process.mainModule.require('electron').BrowserWindow.getAllWindows().length"), 2, "DevTools is not an app window");
  assert.equal(await s.evaluate("main", "typeof require"), "undefined", "the main process inspector has no global require");
  assert.equal(await s.evaluate("main", "process.mainModule.require('electron').app.getName()"), "electron-agent-debug-vue-app");

  // The console was noisy before anyone attached: the replay overflows the buffer, and sinceAttach leaves it out.
  await s.renderer("document.querySelectorAll('li.task').length === 2");
  const everything = await s.call("electron_logs", { process: "renderer", limit: 500 });
  assert.ok(everything.events.some((event) => event.message.includes("hot update")), "the replayed noise should be there");
  assert.equal(everything.gap, true, "800 replayed lines cannot fit into the event buffer");
  assert.ok(everything.droppedThroughSeq > 0);
  const fresh = await s.call("electron_logs", { process: "renderer", sinceAttach: true, limit: 500 });
  assert.equal(fresh.events.some((event) => event.message.includes("hot update")), false, "replayed history leaked");
  assert.equal(fresh.gap, false, "nothing observed after the connection was lost");

  // The Activity page has 1500 rows: the default budget truncates, the heading still shows first.
  await s.call("electron_click", { role: "link", name: "Activity" });
  await s.renderer("document.querySelectorAll('li').length > 1000");
  const snapshot = await s.call("electron_dom_snapshot", {});
  assert.equal(snapshot.truncated, true);
  assert.equal(snapshot.nodeCount, 400);
  assert.match(snapshot.text, /heading "Activity"/u);
  assert.equal(snapshot.text.includes("row 1499"), false);
  const larger = await s.call("electron_dom_snapshot", { maxNodes: 2000 });
  assert.ok(larger.nodeCount > snapshot.nodeCount);

  // A click made by script is not a user's click, but the handler still runs.
  await s.call("electron_click", { role: "link", name: "Tasks" });
  await s.renderer("document.querySelectorAll('li.task').length === 2");
  const trusted = await s.evaluate("renderer", `new Promise((resolve) => {
    document.addEventListener('click', (event) => resolve(event.isTrusted), { once: true });
    [...document.querySelectorAll('button')].find((button) => button.textContent === 'Sync').click();
  })`);
  assert.equal(trusted, false, "an evaluated click is not trusted");
  await s.renderer("!document.body.innerText.includes('Last sync: never')");
});

// A crashed page keeps its connection and says so; an app that exits takes its code with it.
scenarios["crash-and-exit"] = () => withSession({ built: true }, async (s) => {
  await s.attach();
  await s.renderer(taskCount(2));
  const rendererStatus = async () => (await s.call("electron_status")).renderer;
  await s.electron("electron.BrowserWindow.getAllWindows()[0].webContents.forcefullyCrashRenderer(); return true");
  await waitUntil(rendererStatus, (renderer) => renderer.error?.code === "TARGET_CRASHED", "renderer crash status", 8_000);
  assert.equal((await s.failure("electron_evaluate", { scope: "renderer", expression: "1" })).code, "TARGET_CRASHED");
  assert.equal(await s.evaluate("main", "1 + 1"), 2, "the main channel is unaffected by a renderer crash");
  await s.electron("electron.BrowserWindow.getAllWindows()[0].webContents.reload(); return true");
  await waitUntil(rendererStatus, (renderer) => renderer.online === true, "renderer recovery", 10_000);

  // The whole app goes down with a recognisable code. Node waits for an attached inspector client to disconnect before
  // the process can exit, so with the MCP attached it may linger; it exits with its code once the MCP is gone.
  await s.evaluate("main", "setTimeout(() => process.mainModule.require('electron').app.exit(3), 50); true");
  await s.client.close();
  const { code } = await s.app.exited;
  assert.equal(code, 3);

  // A new session finds the app gone and says which channel is missing.
  const later = await s.newSession({});
  const response = await later.raw("electron_attach", { mainUrl: s.app.mainUrl, rendererUrl: s.app.rendererUrl });
  assert.equal(response.result.isError, true, "attach to an app that has exited must be an error");
  const again = response.result.structuredContent.data;
  assert.equal(again.main.online, false);
  assert.ok(again.errors.some((error) => error.code === "MAIN_INSPECTOR_UNAVAILABLE"), JSON.stringify(again.errors));
});

// A project with "type": "module" gets an ES module main process. The way into Electron's API from the inspector has to
// work there too.
scenarios["esm-main"] = () => withSession({ built: true, esm: true }, async (s) => {
  const attached = await s.attach({ instrument: ["ipc"] });
  assert.ok(attached.main.online && attached.renderer.online, JSON.stringify(attached));
  await s.renderer(taskCount(2));
  assert.equal(await s.evaluate("main", "process.argv.some((argument) => argument.endsWith('index.mjs'))"), true, "the main process is the ES module build");
  assert.equal(await s.evaluate("main", "typeof require"), "undefined");
  assert.equal(await s.evaluate("main", "process.mainModule?.require('electron').BrowserWindow.getAllWindows().length"), 1);
  assert.equal(await s.evaluate("main", "process.getBuiltinModule('node:process') === process"), true);
  await s.call("electron_type", { role: "textbox", name: "New task", text: "From an ES module" });
  await s.call("electron_click", { role: "button", name: "Add" });
  await s.renderer(taskCount(3));
});
