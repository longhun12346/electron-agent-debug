import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { discovery, taskCount, waitUntil, withSession } from "../support.mjs";

// The inspection tools and the event rendering depend on Chromium and Node inspector behaviour that the test doubles in
// tests/ can only assume. This runs them against the task board's built app, on a 2x screen.
export const scenarios = {};

scenarios.inspection = async () => {
  const outputDir = await mkdtemp(path.join(tmpdir(), "electron inspection smoke "));
  try {
    await withSession({
      built: true,
      electronArgs: ["--force-device-scale-factor=2"],
      mcpEnv: { ELECTRON_DEBUG_OUTPUT_DIR: outputDir },
    }, (s) => inspection(s, outputDir));
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
};

async function inspection(s, outputDir) {
  const { app } = s;
  const evaluate = s.evaluateFull;
  const value = async (scope, expression, extra) => (await evaluate(scope, expression, extra)).value;
  // Attaching installs nothing in the app by default; this checks both tracings, so it asks for them.
  const attached = await s.attach({ instrument: ["ipc", "dialogs"] });
  assert.ok(attached.main.online && attached.renderer.online, JSON.stringify(attached));

  // wait_for: an expression that becomes true, one that never does, and a log that appears later.
  assert.equal((await s.renderer(taskCount(2))).matched, true);
  const timedOut = await s.failure("electron_wait_for", {
    expression: { scope: "renderer", expression: "document.title === 'never'" }, timeoutMs: 400, intervalMs: 100,
  });
  assert.equal(timedOut.code, "WAIT_TIMEOUT");
  const marker = randomUUID();
  await value("renderer", `setTimeout(() => console.log('later-${marker}'), 300); true`);
  await s.call("electron_wait_for", { log: { contains: `later-${marker}`, process: "renderer" }, timeoutMs: 10_000 });

  // evaluate against real V8: promises, top-level await, redeclaration, errors and limits.
  assert.equal(await value("renderer", "document.title"), "Task Board");
  assert.equal(await value("renderer", "Promise.resolve(7)"), 7);
  assert.equal(await value("renderer", "await Promise.resolve(41) + 1"), 42);
  assert.equal(await value("renderer", "const smokeValue = 1; smokeValue"), 1);
  assert.equal(await value("renderer", "const smokeValue = 2; smokeValue"), 2);
  // Redeclaration together with top-level await reaches the last retry step: the block run again in replMode.
  assert.equal(await value("renderer", "const smokeValue = await Promise.resolve(3); smokeValue"), 3);
  // The main process goes through the Node inspector, whose messages the retry also has to recognise.
  assert.equal(await value("main", "const smokeMain = 1; smokeMain"), 1);
  assert.equal(await value("main", "const smokeMain = 2; smokeMain"), 2);
  assert.equal(await value("main", "const smokeMain = await Promise.resolve(3); smokeMain"), 3);
  assert.equal((await value("renderer", "await window.api.info()")).platform, process.platform);
  assert.equal(await value("main", "process.type"), "browser");
  assert.equal(await s.electron("return electron.BrowserWindow.getAllWindows().length"), 1);
  assert.equal((await evaluate("renderer", "0/0")).text, "NaN");
  assert.deepEqual(await value("renderer", "({ token: 'abc12345678', ok: true })"), { token: "abc12345678", ok: true });
  const wide = await evaluate("renderer", "'中'.repeat(2000)", { maxResultBytes: 256 });
  assert.equal(wide.truncated, true);
  assert.equal(wide.text, `"${"中".repeat(85)}`);
  const thrown = await s.failure("electron_evaluate", { scope: "renderer", expression: "throw new Error('smoke evaluate failure')" });
  assert.equal(thrown.code, "EVALUATION_FAILED");
  assert.match(thrown.message, /smoke evaluate failure/u);
  assert.equal((await s.failure("electron_evaluate", { scope: "renderer", expression: "window" })).code, "EVALUATION_FAILED");
  const slow = await s.failure("electron_evaluate", { scope: "renderer", expression: "new Promise(() => {})", timeoutMs: 300 });
  assert.ok(["EVALUATION_FAILED", "PROTOCOL_ERROR"].includes(slow.code), JSON.stringify(slow));
  assert.equal(await value("renderer", "1 + 1"), 2, "the session must survive a timed-out evaluation");

  // V8 words a top-level await mistake differently depending on what follows `await`: `await (…)` is a ReferenceError at
  // run time, not a compile error. With nothing before it nothing has run, so it must still work, in both inspectors.
  for (const scope of ["renderer", "main"]) {
    assert.equal(await value(scope, "await (async () => 41)()"), 41, `${scope}: await (…) first`);
    assert.equal(await value(scope, "  \nawait (await Promise.resolve(6)) * 7"), 42, `${scope}: leading blanks`);
  }
  // After other statements earlier code may have run, so it is not retried; the error says what to write.
  // A SyntaxError thrown by code that ran (JSON.parse) has run once and must not be retried either.
  const runtimeSyntax = await s.failure("electron_evaluate", {
    scope: "renderer", expression: "globalThis.smokeRuns = (globalThis.smokeRuns ?? 0) + 1; JSON.parse('{x')",
  });
  assert.equal(runtimeSyntax.code, "EVALUATION_FAILED");
  assert.equal(await value("renderer", "globalThis.smokeRuns"), 1, "code that ran must not be retried");
  const awaitLater = await s.failure("electron_evaluate", {
    scope: "renderer", expression: "globalThis.smokeAwait = 1; await (async () => 1)()",
  });
  assert.equal(awaitLater.code, "EVALUATION_FAILED");
  assert.match(awaitLater.message, /await is not defined[\s\S]*async/u);
  assert.equal(await value("renderer", "globalThis.smokeAwait"), 1, "the earlier statement ran exactly once");

  // Uncaught exceptions and console.trace arrive as readable text with a stack, in the right channel.
  let { lastSeq } = await s.call("electron_logs", {});
  await value("renderer", `setTimeout(function smokeThrow() { throw new Error('boom-${marker}'); }, 0); true`);
  const exception = await s.eventAfter(lastSeq, "renderer", `boom-${marker}`);
  assert.equal(exception.kind, "exception");
  assert.match(exception.message, new RegExp(`^Uncaught Error: boom-${marker}\\n\\s+at smokeThrow`, "u"));
  assert.ok(exception.message.length < 1_000, exception.message);

  ({ lastSeq } = await s.call("electron_logs", {}));
  await value("renderer", `setTimeout(function smokeReject() { Promise.reject('reject-${marker}'); }, 0); true`);
  const rejection = await s.eventAfter(lastSeq, "renderer", `reject-${marker}`);
  assert.equal(rejection.kind, "exception");
  assert.match(rejection.message, new RegExp(`^Uncaught \\(in promise\\) reject-${marker}`, "u"));

  for (const scope of ["renderer", "main"]) {
    ({ lastSeq } = await s.call("electron_logs", {}));
    await value(scope, `(function smokeTrace() { console.trace('trace-${scope}-${marker}'); })(); true`);
    const trace = await s.eventAfter(lastSeq, scope, `trace-${scope}-${marker}`);
    assert.equal(trace.process, scope);
    assert.match(trace.message, /\n\s+at smokeTrace /u, `${scope} trace: ${trace.message}`);
  }
  ({ lastSeq } = await s.call("electron_logs", {}));
  await value("renderer", `(function smokeAssert() { console.assert(false, 'assert-${marker}'); })(); true`);
  assert.match((await s.eventAfter(lastSeq, "renderer", `assert-${marker}`)).message, /\n\s+at smokeAssert /u);

  // sinceAttach drops what Chromium and Node replayed on attach: everything it returns is newer than the connection.
  for (const scope of ["renderer", "main"]) {
    const everything = await s.call("electron_logs", { process: scope, limit: 500 });
    const connected = everything.events.filter((event) => event.kind === "connection" && event.message === "Session connected").at(-1);
    assert.ok(connected, `${scope} should have recorded its connection`);
    const since = await s.call("electron_logs", { process: scope, sinceAttach: true, limit: 500 });
    assert.ok(since.events.length > 0, `${scope} should have events since attach`);
    assert.ok(since.events.every((event) => event.seq > connected.seq), `${scope}: replayed history leaked through`);
    assert.equal(since.events.length, everything.events.filter((event) => event.seq > connected.seq).length);
    assert.equal(since.gap, false);
  }

  // dom_snapshot and screenshot against the real page.
  const snapshot = await s.call("electron_dom_snapshot", {});
  assert.match(snapshot.text, /heading "Tasks"/u);
  assert.match(snapshot.text, /Review the pull request/u);
  assert.match(snapshot.url, /^file:.*index\.html/u);
  assert.equal((await s.call("electron_dom_snapshot", { maxNodes: 1 })).truncated, true);

  const shot = await s.call("electron_screenshot", {});
  assert.equal(path.dirname(shot.path), outputDir);
  const png = await readFile(shot.path);
  assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  assert.equal(shot.bytes, png.length);
  assert.ok(png.readUInt32BE(16) > 100 && png.readUInt32BE(20) > 100, "screenshot should have real dimensions");
  // The reported size is the image's size, and by default that is the page's CSS size whatever the screen's DPI.
  assert.deepEqual([png.readUInt32BE(16), png.readUInt32BE(20)], [shot.width, shot.height]);
  const cssSize = await value("renderer", "[innerWidth, innerHeight]");
  assert.ok(Math.abs(shot.width - cssSize[0]) <= 1 && Math.abs(shot.height - cssSize[1]) <= 1,
    `screenshot ${shot.width}x${shot.height} should match the CSS viewport ${cssSize}`);
  assert.equal(shot.deviceScaleFactor, 2);
  const sharp = await s.call("electron_screenshot", { maxWidth: 4_000 });
  assert.equal(sharp.width, (await readFile(sharp.path)).readUInt32BE(16));
  assert.ok(Math.abs(sharp.width - cssSize[0] * 2) <= 2, `full resolution ${sharp.width} for CSS width ${cssSize[0]}`);
  const small = await s.call("electron_screenshot", { maxWidth: 200 });
  assert.equal((await readFile(small.path)).readUInt32BE(16), 200);
  assert.equal(small.width, 200);
  const jpeg = await s.call("electron_screenshot", { format: "jpeg", quality: 60 });
  assert.deepEqual([...(await readFile(jpeg.path)).subarray(0, 2)], [0xff, 0xd8]);
  assert.equal((await readdir(outputDir)).length, 4);

  // Chromium keeps the connection of a crashed page open and the page answers nothing, so the session has to say so
  // instead of letting every request time out. Reloading the page recovers the same connection.
  ({ lastSeq } = await s.call("electron_logs", {}));
  await s.electron("electron.BrowserWindow.getAllWindows()[0].webContents.forcefullyCrashRenderer(); return true");
  const crashedStatus = await waitUntil(async () => (await s.call("electron_status")).renderer,
    (renderer) => renderer.online === false && renderer.error?.code === "TARGET_CRASHED", "renderer crash status", 8_000);
  assert.equal(crashedStatus.status, "offline");
  const crashedStartedAt = Date.now();
  assert.equal((await s.failure("electron_evaluate", { scope: "renderer", expression: "1 + 1" })).code, "TARGET_CRASHED");
  assert.ok(Date.now() - crashedStartedAt < 2_000, "a crashed page must fail fast, not after the request timeout");
  assert.equal((await s.eventAfter(lastSeq, "renderer", "Target crashed", 5_000)).kind, "exception");
  assert.equal(await value("main", "1 + 1"), 2, "the main channel is unaffected by a renderer crash");
  await s.electron("electron.BrowserWindow.getAllWindows()[0].webContents.reload(); return true");
  await waitUntil(async () => (await s.call("electron_status")).renderer,
    (renderer) => renderer.online === true && renderer.error === undefined, "renderer recovery after reload", 10_000);
  assert.equal(await value("renderer", "1 + 1"), 2);

  // IPC tracing: the main channel records each message a renderer sends, with its outcome, without the app logging.
  // A handler registered before the attach (tasks:list) and one registered after it are both traced.
  await s.electron(`electron.ipcMain.removeHandler('tasks:toggle');
    electron.ipcMain.handle('tasks:toggle', async (_event, id) => { if (id === 'boom') throw new Error('late failure'); return []; });
    electron.ipcMain.removeAllListeners('sync:start');
    return true`);
  await s.renderer(taskCount(2));
  ({ lastSeq } = await s.call("electron_logs", {}));
  assert.equal((await value("renderer", "(await window.api.listTasks()).length")), 2);
  assert.deepEqual(await value("renderer", "await window.api.toggleTask('t1')"), []);
  assert.equal(await value("renderer", "window.api.toggleTask('boom').catch(() => 'rejected')"), "rejected");
  assert.equal(await value("renderer", "window.api.getTheme()"), "light");
  await value("renderer", "window.api.startSync(); true");
  await s.eventAfter(lastSeq, "main", "IPC send sync:start");
  const traced = (await s.call("electron_logs", { process: "main", afterSeq: lastSeq, limit: 100 })).events
    .filter((event) => event.kind === "ipc").map((event) => `${event.level} ${event.message.replace(/ in \d+ms| after \d+ms/u, "")}`);
  assert.deepEqual(traced, [
    "info IPC invoke tasks:list ok",
    "info IPC invoke tasks:toggle ok",
    "error IPC invoke tasks:toggle failed: Error: late failure",
    "info IPC sendSync theme:get ok",
    "warn IPC send sync:start: no listener in the main process",
  ], JSON.stringify(traced));

  // A listener on webContents.ipc hears a message too, so it is not reported as unheard.
  await s.electron("for (const window of electron.BrowserWindow.getAllWindows()) window.webContents.ipc.on('sync:start', () => {}); return true");
  ({ lastSeq } = await s.call("electron_logs", {}));
  await value("renderer", "window.api.startSync(); true");
  const heard = await s.eventAfter(lastSeq, "main", "IPC send sync:start");
  assert.ok(!heard.message.includes("no listener"), heard.message);

  // Dialogs: a page's alert blocks its scripts, and a native dialog waits for the user. Both are reported in status
  // and the timeline, and a request that times out behind a blocking dialog says why.
  // A second debugger client closes the alert the way a user would. It has to enable the Page domain before the
  // alert opens, or Chromium does not let it answer the dialog.
  await s.electron(`const wc = electron.BrowserWindow.getAllWindows()[0].webContents;
    wc.debugger.attach('1.3');
    await wc.debugger.sendCommand('Page.enable');
    return true`);
  ({ lastSeq } = await s.call("electron_logs", {}));
  await value("renderer", "setTimeout(() => alert('smoke-alert'), 0); true");
  const alerted = await waitUntil(() => s.call("electron_status"), (status) => status.dialogs?.length === 1, "alert in status");
  assert.equal(alerted.dialogs[0].kind, "javascript");
  assert.equal(alerted.dialogs[0].message, "smoke-alert");
  const blockedEvaluate = await s.failure("electron_evaluate", { scope: "renderer", expression: "1", timeoutMs: 300 });
  assert.match(blockedEvaluate.hint ?? "", /对话框/u, JSON.stringify(blockedEvaluate));
  await s.electron(`const wc = electron.BrowserWindow.getAllWindows()[0].webContents;
    try { await wc.debugger.sendCommand('Page.handleJavaScriptDialog', { accept: true }); } finally { wc.debugger.detach(); }
    return true`);
  await waitUntil(() => s.call("electron_status"), (status) => status.dialogs === undefined, "alert closed");
  assert.equal(await value("renderer", "1 + 1"), 2);
  await s.eventAfter(lastSeq, "renderer", "JavaScript dialog alert closed");

  // A renderer crash while an alert is open: the dialog dies with the page and no Closed event follows, so the record
  // must go with it, or status keeps reporting a blocking dialog after the reload and every later timeout blames it.
  await value("renderer", "setTimeout(() => alert('smoke-crash-alert'), 0); true");
  await waitUntil(() => s.call("electron_status"), (status) => status.dialogs?.length === 1, "alert before crash");
  ({ lastSeq } = await s.call("electron_logs", {}));
  await s.electron("electron.BrowserWindow.getAllWindows()[0].webContents.forcefullyCrashRenderer(); return true");
  await waitUntil(() => s.call("electron_status"), (status) => status.dialogs === undefined, "alert dropped by the crash");
  await s.eventAfter(lastSeq, "renderer", "JavaScript dialog alert closed (the page crashed)", 5_000);
  await s.electron("electron.BrowserWindow.getAllWindows()[0].webContents.reload(); return true");
  await waitUntil(() => s.call("electron_status"), (status) => status.renderer.online === true, "renderer after crash reload", 10_000);
  assert.equal(await value("renderer", "1 + 1"), 2);
  assert.equal((await s.call("electron_status")).dialogs, undefined, "no stale dialog after the reload");

  await s.electron(`globalThis.smokeDialog = new AbortController();
    void electron.dialog.showMessageBox(electron.BrowserWindow.getAllWindows()[0], { title: 'Smoke', message: 'smoke-native', signal: smokeDialog.signal });
    return true`);
  const native = await waitUntil(() => s.call("electron_status"), (status) => status.dialogs?.length === 1, "native dialog in status");
  assert.deepEqual([native.dialogs[0].kind, native.dialogs[0].type, native.dialogs[0].blocking, native.dialogs[0].message],
    ["native", "showMessageBox", false, "smoke-native"]);
  assert.equal(await value("main", "1 + 1"), 2, "an async native dialog does not block the main process");
  await value("main", "smokeDialog.abort(); true");
  await waitUntil(() => s.call("electron_status"), (status) => status.dialogs === undefined, "native dialog closed");

  // A second window with a <webview>: two windows need an explicit choice, and the webview guest is listed and can be
  // chosen but is never picked on its own.
  await s.electron(`const extra = new electron.BrowserWindow({ width: 400, height: 300, show: true, webPreferences: { webviewTag: true } });
    globalThis.smokeExtra = extra;
    const guest = new Promise((resolve) => extra.webContents.once('did-attach-webview', (_event, wc) =>
      wc.once('did-finish-load', resolve)));
    await extra.loadURL("data:text/html,<title>smoke-host</title><webview src='data:text/html,<title>smoke-guest</title>'></webview>");
    await guest;
    return true`);
  const twoWindows = await s.call("electron_targets", { clearSelection: true });
  assert.equal(twoWindows.errors[0]?.code, "TARGET_SELECTION_REQUIRED", JSON.stringify(twoWindows));
  assert.ok(twoWindows.errors[0].hint);
  const guestTarget = twoWindows.targets.find((target) => target.type === "webview");
  assert.ok(guestTarget, JSON.stringify(twoWindows.targets));
  const onGuest = await s.call("electron_targets", { targetId: guestTarget.id });
  assert.equal(onGuest.selectedTarget.id, guestTarget.id);
  assert.equal(await value("renderer", "document.title"), "smoke-guest");
  await value("main", "globalThis.smokeExtra.destroy(); true");
  const back = await s.call("electron_targets", { clearSelection: true });
  assert.match(back.selectedTarget.url, /^file:.*index\.html/u, JSON.stringify(back));

  // Dev builds often open DevTools at startup, which lists it as a second page. A fresh attach (a new server with no
  // remembered selection) must still pick the window under test, and DevTools must stay in the target list.
  await s.electron("electron.BrowserWindow.getAllWindows()[0].webContents.openDevTools({ mode: 'detach' }); return true");
  await waitUntil(() => discovery(app.rendererPort),
    (targets) => targets?.some((target) => target.url.startsWith("devtools://")), "DevTools target");
  const fresh = await s.newSession({});
  const reattached = await fresh.attach();
  assert.equal(reattached.renderer.online, true, JSON.stringify(reattached.errors));
  // Ports passed the wrong way round fail with a hint instead of attaching to the wrong process.
  const swappedResponse = await fresh.raw("electron_attach", { mainUrl: app.rendererUrl, rendererUrl: app.mainUrl });
  // No channel came up, so the attach fails; the reasons stay available in data.errors.
  assert.equal(swappedResponse.result.isError, true, "an attach that reaches no channel must be an error");
  const swapped = swappedResponse.result.structuredContent.data;
  assert.deepEqual(swapped.errors.map((error) => [error.code, /传反/u.test(error.hint ?? "")]),
    [["MAIN_INSPECTOR_UNAVAILABLE", true], ["RENDERER_CDP_UNAVAILABLE", true]], JSON.stringify(swapped.errors));
  assert.match(reattached.selectedTarget.url, /^file:.*index\.html/u);
  assert.ok(reattached.targets.some((target) => target.url.startsWith("devtools://")), "DevTools should stay listed");
}
