import assert from "node:assert/strict";
import { McpClient, structuredData, waitUntil } from "../fixture/test-support.mjs";
import { startField } from "./field-launch.mjs";

// Real Electron, shaped like a development build of a real app: an ESM main process, two windows, DevTools open at
// startup, a console that was noisy before anyone attached, a page far larger than the snapshot budget, a button that
// does nothing until it is pressed, and failures that bring a page or the whole app down. The minimal fixture next to it
// has none of these, and each of them has already exposed a bug that the minimal fixture could not.
const field = await startField({ fault: "save" });
const client = new McpClient(field.endpoints);

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
const rendererStatus = async () => (await call("electron_status")).renderer;
const step = (name) => console.log(`field smoke: ${name}`);

try {
  await client.request(requestId++, "initialize", {
    protocolVersion: "2025-03-26", capabilities: {},
    clientInfo: { name: "field-smoke", version: "1.0.0" },
  });
  client.notify("notifications/initialized", {});

  step("two windows plus DevTools");
  // Two real windows plus DevTools: the tool cannot guess, and must say it is two windows, not three.
  const attached = await call("electron_attach");
  assert.equal(attached.main.online, true);
  assert.equal(attached.renderer.online, false);
  const selection = attached.errors.find((error) => error.code === "TARGET_SELECTION_REQUIRED");
  assert.ok(selection, JSON.stringify(attached.errors));
  assert.equal(selection.details.count, 2, "DevTools must not count as a window to choose from");
  assert.equal(attached.targets.filter((target) => target.url.startsWith("devtools://")).length, 1);

  step("choose by title");
  // Choosing by title is how an agent recovers.
  const chosen = await call("electron_targets", { title: "Field App" });
  assert.equal(chosen.selectedTarget.title, "Field App");
  assert.equal((await rendererStatus()).online, true);

  step("replayed console noise");
  // The console was noisy before anyone attached: the replay overflows the buffer, and sinceAttach leaves it out.
  const everything = await call("electron_logs", { process: "renderer", limit: 500 });
  assert.ok(everything.events.some((event) => event.message.includes("hot update")), "the replayed noise should be there");
  assert.equal(everything.gap, true, "800 replayed lines cannot fit into the event buffer");
  assert.ok(everything.droppedThroughSeq > 0);
  const fresh = await call("electron_logs", { process: "renderer", sinceAttach: true, limit: 500 });
  assert.equal(fresh.events.some((event) => event.message.includes("hot update")), false, "replayed history leaked");
  assert.equal(fresh.gap, false, "nothing observed after the connection was lost");

  step("large page snapshot");
  // A page with 1500 rows: the default budget truncates, the heading and the button still show first.
  const snapshot = await call("electron_dom_snapshot", {});
  assert.equal(snapshot.truncated, true);
  assert.equal(snapshot.nodeCount, 400);
  assert.match(snapshot.text, /heading "Field App"/u);
  assert.match(snapshot.text, /button "Save"/u);
  assert.equal(snapshot.text.includes("row 1499"), false);
  const larger = await call("electron_dom_snapshot", { maxNodes: 2000 });
  assert.ok(larger.nodeCount > snapshot.nodeCount);

  step("click and IPC failure");
  // Nothing happens until the button is pressed. An evaluated click is untrusted, but the handler runs.
  const { lastSeq } = await call("electron_status");
  const trusted = await evaluate("renderer",
    "new Promise((resolve) => { document.addEventListener('click', (event) => resolve(event.isTrusted), { once: true }); document.querySelector('#probe').click(); })");
  assert.equal(trusted.value, false, "an evaluated click is not trusted");
  await evaluate("renderer", "document.querySelector('#save').click(); true");
  await call("electron_wait_for", {
    log: { contains: "FIELD_SAVE_CALL_FAILURE", process: "renderer", afterSeq: lastSeq }, timeoutMs: 5_000,
  });
  await call("electron_wait_for", {
    log: { contains: "FIELD_SAVE_HANDLER_FAILURE", process: "main", afterSeq: lastSeq }, timeoutMs: 5_000,
  });
  await call("electron_wait_for", {
    expression: { scope: "renderer", expression: "document.querySelector('#status').textContent === 'save-failed'" },
    timeoutMs: 5_000,
  });

  step("ESM main process");
  // An ESM main process has no require; the documented way in still works, and DevTools is not an app window.
  assert.equal((await evaluate("main", "typeof require")).value, "undefined");
  assert.equal((await evaluate("main", "process.mainModule.require('electron').app.getName()")).value,
    "electron-agent-debug-field-app");
  assert.equal((await evaluate("main", "process.mainModule.require('electron').BrowserWindow.getAllWindows().length")).value, 2);

  step("renderer crash and recovery");
  // A crashed page keeps its connection: the session says so, and reloading recovers it.
  await field.command("crash-renderer");
  await waitUntil(rendererStatus, (renderer) => renderer.error?.code === "TARGET_CRASHED", "renderer crash status", 8_000);
  assert.equal((await failure("electron_evaluate", { scope: "renderer", expression: "1" })).code, "TARGET_CRASHED");
  assert.equal((await evaluate("main", "1 + 1")).value, 2);
  await field.command("reload");
  await waitUntil(rendererStatus, (renderer) => renderer.online === true, "renderer recovery", 10_000);

  step("hard exit");
  // The whole app goes down and the exit code is the runner's to read. Node waits for an attached inspector client to
  // disconnect before the process can exit ("Waiting for the debugger to disconnect…"), so with the MCP attached the
  // process may linger; it exits with its code as soon as the MCP is gone. Both are recorded, only the code is required.
  field.command("exit", 1_000).catch(() => undefined);
  const early = await Promise.race([field.exited, new Promise((resolve) => setTimeout(resolve, 3_000, "waiting"))]);
  const lingeredWhileAttached = early === "waiting";
  await client.close();
  const { code } = await field.exited;
  assert.equal(code, 3);

  // A new session finds the app gone and says which channel is missing.
  const later = new McpClient({});
  try {
    await later.request(requestId++, "initialize", {
      protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "field-smoke-later", version: "1.0.0" },
    });
    later.notify("notifications/initialized", {});
    const again = structuredData(await later.request(requestId++, "tools/call", {
      name: "electron_attach", arguments: {
        mainUrl: `http://127.0.0.1:${field.mainPort}`, rendererUrl: `http://127.0.0.1:${field.rendererPort}`,
      },
    }, 30_000), "attach after exit");
    assert.equal(again.main.online, false);
    assert.ok(again.errors.some((error) => error.code === "MAIN_INSPECTOR_UNAVAILABLE"), JSON.stringify(again.errors));
  } finally {
    await later.close();
  }

  console.log(JSON.stringify({
    platform: process.platform, windows: 2, replayedNoiseDropped: everything.droppedThroughSeq,
    snapshotNodes: snapshot.nodeCount, lingeredWhileAttached,
  }));
} finally {
  await client.close();
  await field.stop();
}
