import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { McpClient, discovery, freePort, startApp, taskCount, waitUntil, withSession } from "../support.mjs";

// One MCP process through a reload, a replaced window and a restart of the whole app on new ports, and an attach with
// nothing to attach to.
export const scenarios = {};

scenarios.lifecycle = () => withSession({ built: true }, async (s) => {
  const mcpPid = s.client.child.pid;
  const first = s.app;
  const run = randomUUID();
  const mainSaw = (name) => waitUntil(() => s.logs({ process: "main" }),
    (events) => events.some((event) => event.message.includes(`MAIN-MARK ${run} ${name}`)), `main evidence: ${name}`);
  const attached = await s.attach();
  assert.ok(attached.main.online && attached.renderer.online);
  const oldTarget = attached.selectedTarget.id;
  await s.renderer(taskCount(2));

  // Reload: the same target, a fresh page, fresh evidence from both channels.
  await s.evaluate("renderer", "window.__page = 'before'; true");
  await s.call("electron_logs", { clear: true });
  await s.electron("electron.BrowserWindow.getAllWindows()[0].webContents.reload(); return true");
  await s.renderer(`window.__page === undefined && ${taskCount(2)}`);
  await s.evaluate("main", `console.log('MAIN-MARK ${run} reload'); true`);
  await mainSaw("reload");
  const reloaded = await s.call("electron_status");
  assert.equal(reloaded.renderer.online, true);
  assert.equal(reloaded.selectedTarget.id, oldTarget);

  // Replacing the window: the old target goes away, and the switch to the new one is reported, never silent.
  await s.call("electron_logs", { clear: true });
  await s.electron(`const old = electron.BrowserWindow.getAllWindows()[0];
    const next = new electron.BrowserWindow({ width: 800, height: 600, webPreferences: { preload: process.getBuiltinModule("node:path").join(electron.app.getAppPath(), "out/preload/index.js") } });
    const loaded = new Promise((resolve) => next.webContents.once('did-finish-load', resolve));
    void next.loadURL(old.webContents.getURL());
    await loaded;
    old.destroy();
    return true`);
  await waitUntil(() => s.call("electron_status"),
    (status) => !status.renderer.online && !status.selectedTarget && status.targets.length === 0, "old renderer disconnected");
  const replacement = await s.call("electron_targets", {});
  assert.ok(replacement.selectedTarget);
  assert.notEqual(replacement.selectedTarget.id, oldTarget);
  assert.equal(replacement.warnings[0]?.code, "TARGET_CHANGED", JSON.stringify(replacement));
  assert.equal(replacement.warnings[0].details.previous.id, oldTarget);
  await s.renderer(taskCount(2));

  // The whole app exits normally and starts again on new ports; the same MCP process takes over.
  await s.evaluate("main", `setTimeout(() => {
    process.getBuiltinModule('node:inspector').close();
    process.mainModule.require('electron').app.exit(0);
  }, 50); true`);
  assert.equal((await first.exited).code, 0, "the restart follows a graceful exit");
  await waitUntil(() => s.call("electron_status"),
    (status) => !status.main.online && !status.renderer.online && !status.selectedTarget, "both sessions disconnected after Electron exit");
  await waitUntil(() => Promise.all([discovery(first.mainPort), discovery(first.rendererPort)]),
    (responses) => responses.every((response) => response === undefined), "old ports released");
  await s.call("electron_logs", { clear: true });
  const second = await startApp({ built: true });
  try {
    const recovered = await s.call("electron_attach", { mainUrl: second.mainUrl, rendererUrl: second.rendererUrl, clearSelection: true });
    assert.equal(recovered.main.online, true);
    assert.equal(recovered.renderer.online, true);
    assert.notEqual(recovered.selectedTarget.id, replacement.selectedTarget.id);
    await s.evaluate("main", `console.log('MAIN-MARK ${run} restarted'); true`);
    await mainSaw("restarted");
    assert.equal(s.client.child.pid, mcpPid, "recovery must use the original MCP process");
    const logs = await s.call("electron_logs", { process: "all" });
    assert.equal(logs.events.some((event) => event.message.includes(`MAIN-MARK ${run} reload`)), false, "nothing from the first run");
  } finally {
    await second.stop();
  }
});

// Nothing to attach to: the answer says what is missing, and a dead port names the channel.
scenarios["no-endpoint"] = async () => {
  const client = new McpClient({});
  try {
    await client.request(1, "initialize", {
      protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "vue-vite-no-endpoint", version: "1.0.0" },
    });
    client.notify("notifications/initialized", {});
    const bare = await client.request(2, "tools/call", { name: "electron_attach", arguments: {} });
    assert.equal(bare.result.isError, true);
    assert.equal(bare.result.structuredContent.error?.code, "ENDPOINT_NOT_CONFIGURED");
    const dead = `http://127.0.0.1:${await freePort()}`;
    const refused = await client.request(3, "tools/call", { name: "electron_attach", arguments: { mainUrl: dead, rendererUrl: dead } }, 30_000);
    assert.equal(refused.result.isError, true);
    const { errors } = refused.result.structuredContent.data;
    assert.deepEqual(errors.map((error) => error.code).sort(), ["MAIN_INSPECTOR_UNAVAILABLE", "RENDERER_CDP_UNAVAILABLE"]);
  } finally {
    await client.close();
  }
};
