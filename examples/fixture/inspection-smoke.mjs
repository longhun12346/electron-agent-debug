import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { McpClient, structuredData, freePort, discovery, waitUntil, stopChild } from "./test-support.mjs";

// Real Electron: the inspection tools and the event rendering depend on Chromium and Node inspector behaviour
// that the test doubles in tests/ can only assume.
const electron = createRequire(import.meta.url)("electron");
const fixtureRoot = path.dirname(fileURLToPath(import.meta.url));
const [mainPort, rendererPort] = [await freePort(), await freePort()];
const run = randomUUID();
const outputDir = await mkdtemp(path.join(tmpdir(), "electron inspection smoke "));

// A 2x screen, so the screenshot checks below prove that the default capture is the CSS size, not the device size.
const args = [`--inspect=${mainPort}`, `--remote-debugging-port=${rendererPort}`, "--force-device-scale-factor=2", fixtureRoot];
if (process.env.FIXTURE_ELECTRON_NO_SANDBOX === "true") args.unshift("--no-sandbox");
const env = { ...process.env, FIXTURE_RUN_ID: run, FIXTURE_RENDERER_PORT: rendererPort };
delete env.FIXTURE_FAULT;
const fixture = spawn(electron, args, { stdio: ["ignore", "inherit", "inherit", "ipc"], env });
const client = new McpClient({ ELECTRON_DEBUG_OUTPUT_DIR: outputDir });

let requestId = 1;
async function raw(tool, toolArguments = {}) {
  const response = await client.request(requestId++, "tools/call", { name: tool, arguments: toolArguments }, 30_000);
  assert.ok(response.result?.structuredContent, `${tool}: ${JSON.stringify(response)}`);
  return response;
}
const call = async (tool, toolArguments) => structuredData(await raw(tool, toolArguments), tool);
async function failure(tool, toolArguments) {
  const response = await raw(tool, toolArguments);
  assert.equal(response.result.isError, true, `${tool} should fail: ${JSON.stringify(response)}`);
  return response.result.structuredContent.error;
}
const evaluate = (scope, expression, extra = {}) => call("electron_evaluate", { scope, expression, ...extra });

async function eventAfter(seq, scope, contains) {
  const waited = await call("electron_wait_for", {
    log: { contains, process: scope, afterSeq: seq }, timeoutMs: 5_000,
  });
  return waited.event;
}

try {
  await Promise.all([
    waitUntil(() => discovery(mainPort), Array.isArray, "main discovery"),
    waitUntil(() => discovery(rendererPort),
      (targets) => targets?.some((target) => target.type === "page"), "renderer discovery"),
  ]);
  await client.request(requestId++, "initialize", {
    protocolVersion: "2025-03-26", capabilities: {},
    clientInfo: { name: "fixture-inspection-smoke", version: "1.0.0" },
  });
  client.notify("notifications/initialized", {});
  const attached = await call("electron_attach", {
    mainUrl: `http://127.0.0.1:${mainPort}`, rendererUrl: `http://127.0.0.1:${rendererPort}`,
  });
  assert.ok(attached.main.online && attached.renderer.online, JSON.stringify(attached));

  // wait_for: an expression that becomes true, one that never does, and a log that appears later.
  const ready = await call("electron_wait_for", {
    expression: { scope: "renderer", expression: "document.querySelector('#result')?.textContent === 'fixture-ok'" },
    timeoutMs: 10_000,
  });
  assert.equal(ready.matched, true);
  const timedOut = await failure("electron_wait_for", {
    expression: { scope: "renderer", expression: "document.title === 'never'" }, timeoutMs: 400, intervalMs: 100,
  });
  assert.equal(timedOut.code, "WAIT_TIMEOUT");
  await call("electron_wait_for", {
    log: { contains: `FIXTURE_RENDERER_READY ${run}`, process: "renderer" }, timeoutMs: 10_000,
  });

  // evaluate against real V8: promises, top-level await, redeclaration, errors, limits and redaction.
  assert.equal((await evaluate("renderer", "document.title")).value, "Electron Agent Debug Fixture");
  assert.equal((await evaluate("renderer", "Promise.resolve(7)")).value, 7);
  assert.equal((await evaluate("renderer", "await Promise.resolve(41) + 1")).value, 42);
  assert.equal((await evaluate("renderer", "const smokeValue = 1; smokeValue")).value, 1);
  assert.equal((await evaluate("renderer", "const smokeValue = 2; smokeValue")).value, 2);
  // Redeclaration together with top-level await reaches the last retry step: the block run again in replMode.
  assert.equal((await evaluate("renderer", "const smokeValue = await Promise.resolve(3); smokeValue")).value, 3);
  // The main process goes through the Node inspector, whose messages the retry also has to recognise.
  assert.equal((await evaluate("main", "const smokeMain = 1; smokeMain")).value, 1);
  assert.equal((await evaluate("main", "const smokeMain = 2; smokeMain")).value, 2);
  assert.equal((await evaluate("main", "const smokeMain = await Promise.resolve(3); smokeMain")).value, 3);
  assert.equal((await evaluate("renderer", "await window.fixtureApi.getValue()")).value, "fixture-ok");
  assert.equal((await evaluate("main", "process.type")).value, "browser");
  assert.equal((await evaluate(
    "main", "process.mainModule.require('electron').BrowserWindow.getAllWindows().length",
  )).value, 1);
  assert.equal((await evaluate("renderer", "0/0")).text, "NaN");
  assert.deepEqual((await evaluate("renderer", "({ token: 'abc12345678', ok: true })")).value,
    { token: "[REDACTED]", ok: true });
  const wide = await evaluate("renderer", "'中'.repeat(2000)", { maxResultBytes: 256 });
  assert.equal(wide.truncated, true);
  assert.equal(wide.text, `"${"中".repeat(85)}`);
  const thrown = await failure("electron_evaluate", {
    scope: "renderer", expression: "throw new Error('smoke evaluate failure')",
  });
  assert.equal(thrown.code, "EVALUATION_FAILED");
  assert.match(thrown.message, /smoke evaluate failure/u);
  const unserializable = await failure("electron_evaluate", { scope: "renderer", expression: "window" });
  assert.equal(unserializable.code, "EVALUATION_FAILED");
  const slow = await failure("electron_evaluate", {
    scope: "renderer", expression: "new Promise(() => {})", timeoutMs: 300,
  });
  assert.ok(["EVALUATION_FAILED", "PROTOCOL_ERROR"].includes(slow.code), JSON.stringify(slow));
  assert.equal((await evaluate("renderer", "1 + 1")).value, 2, "the session must survive a timed-out evaluation");

  // V8 words a top-level await mistake differently depending on what follows `await`: `await (…)` is a ReferenceError at
  // run time, not a compile error. With nothing before it nothing has run, so it must still work, in both inspectors.
  for (const scope of ["renderer", "main"]) {
    assert.equal((await evaluate(scope, "await (async () => 41)()")).value, 41, `${scope}: await (…) first`);
    assert.equal((await evaluate(scope, "  \nawait (await Promise.resolve(6)) * 7")).value, 42, `${scope}: leading blanks`);
  }
  // After other statements earlier code may have run, so it is not retried; the error says what to write.
  // A SyntaxError thrown by code that ran (JSON.parse) has run once and must not be retried either.
  const runtimeSyntax = await failure("electron_evaluate", {
    scope: "renderer", expression: "globalThis.smokeRuns = (globalThis.smokeRuns ?? 0) + 1; JSON.parse('{x')",
  });
  assert.equal(runtimeSyntax.code, "EVALUATION_FAILED");
  assert.equal((await evaluate("renderer", "globalThis.smokeRuns")).value, 1, "code that ran must not be retried");
  const awaitLater = await failure("electron_evaluate", {
    scope: "renderer", expression: "globalThis.smokeAwait = 1; await (async () => 1)()",
  });
  assert.equal(awaitLater.code, "EVALUATION_FAILED");
  assert.match(awaitLater.message, /await is not defined[\s\S]*async/u);
  assert.equal((await evaluate("renderer", "globalThis.smokeAwait")).value, 1, "the earlier statement ran exactly once");

  // Uncaught exceptions and console.trace arrive as readable text with a stack, in the right channel.
  const marker = randomUUID();
  let { lastSeq } = await call("electron_logs", {});
  await evaluate("renderer", `setTimeout(function smokeThrow() { throw new Error('boom-${marker}'); }, 0); true`);
  const exception = await eventAfter(lastSeq, "renderer", `boom-${marker}`);
  assert.equal(exception.kind, "exception");
  assert.match(exception.message, new RegExp(`^Uncaught Error: boom-${marker}\\n\\s+at smokeThrow`, "u"));
  assert.ok(exception.message.length < 1_000, exception.message);

  ({ lastSeq } = await call("electron_logs", {}));
  await evaluate("renderer", `setTimeout(function smokeReject() { Promise.reject('reject-${marker}'); }, 0); true`);
  const rejection = await eventAfter(lastSeq, "renderer", `reject-${marker}`);
  assert.equal(rejection.kind, "exception");
  assert.match(rejection.message, new RegExp(`^Uncaught \\(in promise\\) reject-${marker}`, "u"));

  for (const scope of ["renderer", "main"]) {
    ({ lastSeq } = await call("electron_logs", {}));
    await evaluate(scope, `(function smokeTrace() { console.trace('trace-${scope}-${marker}'); })(); true`);
    const trace = await eventAfter(lastSeq, scope, `trace-${scope}-${marker}`);
    assert.equal(trace.process, scope);
    assert.match(trace.message, /\n\s+at smokeTrace /u, `${scope} trace: ${trace.message}`);
  }

  ({ lastSeq } = await call("electron_logs", {}));
  await evaluate("renderer", `(function smokeAssert() { console.assert(false, 'assert-${marker}'); })(); true`);
  const asserted = await eventAfter(lastSeq, "renderer", `assert-${marker}`);
  assert.match(asserted.message, /\n\s+at smokeAssert /u, asserted.message);

  // sinceAttach drops what Chromium and Node replayed on attach: everything it returns is newer than the connection.
  for (const scope of ["renderer", "main"]) {
    const everything = await call("electron_logs", { process: scope, limit: 500 });
    const connected = everything.events.filter((event) =>
      event.kind === "connection" && event.message === "Session connected").at(-1);
    assert.ok(connected, `${scope} should have recorded its connection`);
    const since = await call("electron_logs", { process: scope, sinceAttach: true, limit: 500 });
    assert.ok(since.events.length > 0, `${scope} should have events since attach`);
    assert.ok(since.events.every((event) => event.seq > connected.seq), `${scope}: replayed history leaked through`);
    assert.equal(since.events.length, everything.events.filter((event) => event.seq > connected.seq).length);
    assert.equal(since.gap, false);
  }

  // dom_snapshot and screenshot against the real page.
  const snapshot = await call("electron_dom_snapshot", {});
  assert.match(snapshot.text, /heading "fixture-ready"/u);
  assert.match(snapshot.text, /fixture-ok/u);
  assert.match(snapshot.url, /^file:.*index\.html/u);
  const limited = await call("electron_dom_snapshot", { maxNodes: 1 });
  assert.equal(limited.truncated, true);

  const shot = await call("electron_screenshot", {});
  assert.equal(path.dirname(shot.path), outputDir);
  const png = await readFile(shot.path);
  assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  assert.equal(shot.bytes, png.length);
  assert.ok(png.readUInt32BE(16) > 100 && png.readUInt32BE(20) > 100, "screenshot should have real dimensions");
  // The reported size is the image's size, and by default that is the page's CSS size whatever the screen's DPI.
  assert.deepEqual([png.readUInt32BE(16), png.readUInt32BE(20)], [shot.width, shot.height]);
  const cssSize = (await evaluate("renderer", "[innerWidth, innerHeight]")).value;
  assert.ok(Math.abs(shot.width - cssSize[0]) <= 1 && Math.abs(shot.height - cssSize[1]) <= 1,
    `screenshot ${shot.width}x${shot.height} should match the CSS viewport ${cssSize}`);
  assert.equal(shot.deviceScaleFactor, 2);
  const sharp = await call("electron_screenshot", { maxWidth: 4_000 });
  assert.equal(sharp.width, (await readFile(sharp.path)).readUInt32BE(16));
  assert.ok(Math.abs(sharp.width - cssSize[0] * 2) <= 2, `full resolution ${sharp.width} for CSS width ${cssSize[0]}`);
  const small = await call("electron_screenshot", { maxWidth: 200 });
  const smallPng = await readFile(small.path);
  assert.equal(smallPng.readUInt32BE(16), 200);
  assert.equal(small.width, 200);
  const jpeg = await call("electron_screenshot", { format: "jpeg", quality: 60 });
  assert.deepEqual([...(await readFile(jpeg.path)).subarray(0, 2)], [0xff, 0xd8]);
  assert.equal((await readdir(outputDir)).length, 4);

  // Chromium keeps the connection of a crashed page open and the page answers nothing, so the session has to say so
  // instead of letting every request time out. Reloading the page recovers the same connection.
  ({ lastSeq } = await call("electron_logs", {}));
  await evaluate("main", "(() => { process.mainModule.require('electron').BrowserWindow.getAllWindows()[0].webContents.forcefullyCrashRenderer(); return true; })()");
  const crashedStatus = await waitUntil(async () => (await call("electron_status")).renderer,
    (renderer) => renderer.online === false && renderer.error?.code === "TARGET_CRASHED", "renderer crash status", 8_000);
  assert.equal(crashedStatus.status, "offline");
  const crashedStartedAt = Date.now();
  const crashedEvaluate = await failure("electron_evaluate", { scope: "renderer", expression: "1 + 1" });
  assert.equal(crashedEvaluate.code, "TARGET_CRASHED");
  assert.ok(Date.now() - crashedStartedAt < 2_000, "a crashed page must fail fast, not after the request timeout");
  const crashEvent = await eventAfter(lastSeq, "renderer", "Target crashed");
  assert.equal(crashEvent.kind, "exception");
  assert.equal((await evaluate("main", "1 + 1")).value, 2, "the main channel is unaffected by a renderer crash");
  await evaluate("main", "(() => { process.mainModule.require('electron').BrowserWindow.getAllWindows()[0].webContents.reload(); return true; })()");
  await waitUntil(async () => (await call("electron_status")).renderer,
    (renderer) => renderer.online === true && renderer.error === undefined, "renderer recovery after reload", 10_000);
  assert.equal((await evaluate("renderer", "1 + 1")).value, 2);

  // IPC tracing: the main channel records each message a renderer sends, with its outcome, without the app logging.
  // A handler registered before the attach (fixture:get-value) and one registered after it are both traced.
  await evaluate("main", `(() => {
    const { ipcMain } = process.mainModule.require('electron');
    ipcMain.handle('fixture:late', async (_event, value) => { if (value < 0) throw new Error('fixture late failure'); return value * 2; });
    ipcMain.on('fixture:sync', (event) => { event.returnValue = 'sync-ok'; });
    return true;
  })()`);
  ({ lastSeq } = await call("electron_logs", {}));
  assert.equal((await evaluate("renderer", "fixtureApi.getValue()")).value, "fixture-ok");
  assert.equal((await evaluate("renderer", "fixtureIpc.invoke('fixture:late', 21)")).value, 42);
  assert.equal((await evaluate("renderer", "fixtureIpc.invoke('fixture:late', -1).catch(() => 'rejected')")).value, "rejected");
  assert.equal((await evaluate("renderer", "fixtureIpc.sendSync('fixture:sync')")).value, "sync-ok");
  await evaluate("renderer", "fixtureIpc.send('fixture:nobody'); true");
  await eventAfter(lastSeq, "main", "IPC send fixture:nobody");
  const traced = (await call("electron_logs", { process: "main", afterSeq: lastSeq, limit: 100 })).events
    .filter((event) => event.kind === "ipc").map((event) => `${event.level} ${event.message.replace(/ in \d+ms| after \d+ms/u, "")}`);
  assert.deepEqual(traced, [
    "info IPC invoke fixture:get-value ok",
    "info IPC invoke fixture:late ok",
    "error IPC invoke fixture:late failed: Error: fixture late failure",
    "info IPC sendSync fixture:sync ok",
    "warn IPC send fixture:nobody: no listener in the main process",
  ], JSON.stringify(traced));

  // Dialogs: a page's alert blocks its scripts, and a native dialog waits for the user. Both are reported in status
  // and the timeline, and a request that times out behind a blocking dialog says why.
  // A second debugger client closes the alert the way a user would. It has to enable the Page domain before the
  // alert opens, or Chromium does not let it answer the dialog.
  await evaluate("main", `(async () => {
    const wc = process.mainModule.require('electron').BrowserWindow.getAllWindows()[0].webContents;
    wc.debugger.attach('1.3');
    await wc.debugger.sendCommand('Page.enable');
    return true;
  })()`);
  ({ lastSeq } = await call("electron_logs", {}));
  await evaluate("renderer", "setTimeout(() => alert('smoke-alert'), 0); true");
  const alerted = await waitUntil(() => call("electron_status"), (status) => status.dialogs?.length === 1, "alert in status");
  assert.equal(alerted.dialogs[0].kind, "javascript");
  assert.equal(alerted.dialogs[0].message, "smoke-alert");
  const blockedEvaluate = await failure("electron_evaluate", { scope: "renderer", expression: "1", timeoutMs: 300 });
  assert.match(blockedEvaluate.hint ?? "", /对话框/u, JSON.stringify(blockedEvaluate));
  await evaluate("main", `(async () => {
    const wc = process.mainModule.require('electron').BrowserWindow.getAllWindows()[0].webContents;
    try { await wc.debugger.sendCommand('Page.handleJavaScriptDialog', { accept: true }); } finally { wc.debugger.detach(); }
    return true;
  })()`);
  await waitUntil(() => call("electron_status"), (status) => status.dialogs === undefined, "alert closed");
  assert.equal((await evaluate("renderer", "1 + 1")).value, 2);
  await eventAfter(lastSeq, "renderer", "JavaScript dialog alert closed");

  // A renderer crash while an alert is open: the dialog dies with the page and no Closed event follows, so the record
  // must go with it, or status keeps reporting a blocking dialog after the reload and every later timeout blames it.
  await evaluate("renderer", "setTimeout(() => alert('smoke-crash-alert'), 0); true");
  await waitUntil(() => call("electron_status"), (status) => status.dialogs?.length === 1, "alert before crash");
  ({ lastSeq } = await call("electron_logs", {}));
  await evaluate("main", "process.mainModule.require('electron').BrowserWindow.getAllWindows()[0].webContents.forcefullyCrashRenderer(); true");
  await waitUntil(() => call("electron_status"), (status) => status.dialogs === undefined, "alert dropped by the crash");
  await eventAfter(lastSeq, "renderer", "JavaScript dialog alert closed (the page crashed)");
  await evaluate("main", "process.mainModule.require('electron').BrowserWindow.getAllWindows()[0].webContents.reload(); true");
  await waitUntil(() => call("electron_status"), (status) => status.renderer.online === true, "renderer after crash reload", 10_000);
  assert.equal((await evaluate("renderer", "1 + 1")).value, 2);
  assert.equal((await call("electron_status")).dialogs, undefined, "no stale dialog after the reload");

  await evaluate("main", `(() => {
    const { dialog, BrowserWindow } = process.mainModule.require('electron');
    globalThis.smokeDialog = new AbortController();
    void dialog.showMessageBox(BrowserWindow.getAllWindows()[0], { title: 'Smoke', message: 'smoke-native', signal: smokeDialog.signal });
    return true;
  })()`);
  const native = await waitUntil(() => call("electron_status"), (status) => status.dialogs?.length === 1, "native dialog in status");
  assert.deepEqual([native.dialogs[0].kind, native.dialogs[0].type, native.dialogs[0].blocking, native.dialogs[0].message],
    ["native", "showMessageBox", false, "smoke-native"]);
  assert.equal((await evaluate("main", "1 + 1")).value, 2, "an async native dialog does not block the main process");
  await evaluate("main", "smokeDialog.abort(); true");
  await waitUntil(() => call("electron_status"), (status) => status.dialogs === undefined, "native dialog closed");

  // A second window with a <webview>: two windows need an explicit choice, and the webview guest is listed and can be
  // chosen but is never picked on its own.
  await evaluate("main", `(async () => {
    const { BrowserWindow } = process.mainModule.require('electron');
    const extra = new BrowserWindow({ width: 400, height: 300, show: true, webPreferences: { webviewTag: true } });
    globalThis.smokeExtra = extra;
    const guest = new Promise((resolve) => extra.webContents.once('did-attach-webview', (_event, wc) =>
      wc.once('did-finish-load', resolve)));
    await extra.loadURL("data:text/html,<title>smoke-host</title><webview src='data:text/html,<title>smoke-guest</title>'></webview>");
    await guest;
    return true;
  })()`);
  const twoWindows = await call("electron_targets", { clearSelection: true });
  assert.equal(twoWindows.errors[0]?.code, "TARGET_SELECTION_REQUIRED", JSON.stringify(twoWindows));
  assert.ok(twoWindows.errors[0].hint);
  const guestTarget = twoWindows.targets.find((target) => target.type === "webview");
  assert.ok(guestTarget, JSON.stringify(twoWindows.targets));
  const onGuest = await call("electron_targets", { targetId: guestTarget.id });
  assert.equal(onGuest.selectedTarget.id, guestTarget.id);
  assert.equal((await evaluate("renderer", "document.title")).value, "smoke-guest");
  await evaluate("main", "(() => { globalThis.smokeExtra.destroy(); return true; })()");
  const back = await call("electron_targets", { clearSelection: true });
  assert.match(back.selectedTarget.url, /^file:.*index\.html/u, JSON.stringify(back));

  // Dev builds often open DevTools at startup, which lists it as a second page. A fresh attach (a new server with no
  // remembered selection) must still pick the window under test, and DevTools must stay in the target list.
  await evaluate("main", "(() => { const w = process.mainModule.require('electron').BrowserWindow.getAllWindows()[0]; w.webContents.openDevTools({ mode: 'detach' }); return true; })()");
  await waitUntil(() => discovery(rendererPort),
    (targets) => targets?.some((target) => target.url.startsWith("devtools://")), "DevTools target");
  const fresh = new McpClient({});
  try {
    await fresh.request(requestId++, "initialize", {
      protocolVersion: "2025-03-26", capabilities: {},
      clientInfo: { name: "fixture-inspection-smoke-fresh", version: "1.0.0" },
    });
    fresh.notify("notifications/initialized", {});
    const reattached = structuredData(await fresh.request(requestId++, "tools/call", {
      name: "electron_attach",
      arguments: { mainUrl: `http://127.0.0.1:${mainPort}`, rendererUrl: `http://127.0.0.1:${rendererPort}` },
    }, 30_000), "fresh attach");
    assert.equal(reattached.renderer.online, true, JSON.stringify(reattached.errors));
    // Ports passed the wrong way round fail with a hint instead of attaching to the wrong process.
    const swapped = structuredData(await fresh.request(requestId++, "tools/call", {
      name: "electron_attach",
      arguments: { mainUrl: `http://127.0.0.1:${rendererPort}`, rendererUrl: `http://127.0.0.1:${mainPort}` },
    }, 30_000), "swapped attach");
    assert.deepEqual(swapped.errors.map((error) => [error.code, /传反/u.test(error.hint ?? "")]),
      [["MAIN_INSPECTOR_UNAVAILABLE", true], ["RENDERER_CDP_UNAVAILABLE", true]], JSON.stringify(swapped.errors));
    assert.match(reattached.selectedTarget.url, /^file:.*index\.html/u);
    assert.ok(reattached.targets.some((target) => target.url.startsWith("devtools://")), "DevTools should stay listed");
  } finally {
    await fresh.close();
  }

  console.log(JSON.stringify({
    platform: process.platform, exception: exception.message, snapshotNodes: snapshot.nodeCount, screenshotBytes: shot.bytes,
  }));
} finally {
  await client.close();
  await stopChild(fixture, () => fixture.send({ command: "quit" }));
  await rm(outputDir, { recursive: true, force: true });
}
