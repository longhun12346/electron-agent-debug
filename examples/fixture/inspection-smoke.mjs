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

const args = [`--inspect=${mainPort}`, `--remote-debugging-port=${rendererPort}`, fixtureRoot];
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
  const jpeg = await call("electron_screenshot", { format: "jpeg", quality: 60 });
  assert.deepEqual([...(await readFile(jpeg.path)).subarray(0, 2)], [0xff, 0xd8]);
  assert.equal((await readdir(outputDir)).length, 2);

  console.log(JSON.stringify({
    platform: process.platform, exception: exception.message, snapshotNodes: snapshot.nodeCount, screenshotBytes: shot.bytes,
  }));
} finally {
  await client.close();
  await stopChild(fixture, () => fixture.send({ command: "quit" }));
  await rm(outputDir, { recursive: true, force: true });
}
