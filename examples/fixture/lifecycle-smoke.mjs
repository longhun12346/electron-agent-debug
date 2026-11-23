import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { McpClient, structuredData, freePort, discovery, waitUntil, stopChild } from "./test-support.mjs";

const electron = createRequire(import.meta.url)("electron");
const fixtureRoot = path.dirname(fileURLToPath(import.meta.url));
const client = new McpClient();
let fixture;
let requestId = 1;
let commandId = 1;

async function call(name, args = {}) {
  return structuredData(await client.request(requestId++, "tools/call", {
    name, arguments: args,
  }), name);
}

async function startFixture() {
  const mainPort = await freePort();
  const rendererPort = await freePort();
  const run = randomUUID();
  const args = [`--inspect=${mainPort}`, `--remote-debugging-port=${rendererPort}`, fixtureRoot];
  if (process.env.FIXTURE_ELECTRON_NO_SANDBOX === "true") args.unshift("--no-sandbox");
  const env = { ...process.env, FIXTURE_RUN_ID: run, FIXTURE_RENDERER_PORT: rendererPort };
  delete env.FIXTURE_FAULT;
  fixture = spawn(electron, args, { stdio: ["ignore", "inherit", "inherit", "ipc"], env });
  await Promise.all([
    waitUntil(() => discovery(mainPort), Array.isArray, "main discovery"),
    waitUntil(() => discovery(rendererPort),
      (targets) => targets?.some((target) => target.type === "page"), "renderer discovery"),
  ]);
  return { mainUrl: `http://127.0.0.1:${mainPort}`,
    rendererUrl: `http://127.0.0.1:${rendererPort}`, run, mainPort, rendererPort };
}

function command(command) {
  const id = commandId++;
  return new Promise((resolve, reject) => {
    const child = fixture;
    const cleanup = () => {
      clearTimeout(timer);
      child.off("message", receive);
      child.off("exit", exited);
    };
    const receive = (message) => {
      if (message.id !== id) return;
      cleanup();
      if (message.ok) resolve(id);
      else reject(new Error(message.error));
    };
    const exited = () => { cleanup(); reject(new Error(`fixture exited during ${command}`)); };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`fixture command timeout: ${command}`));
    }, 5_000);
    child.on("message", receive);
    child.once("exit", exited);
    child.send({ id, command }, (error) => {
      if (error) { cleanup(); reject(error); }
    });
  });
}

async function evidence(run, previousMessage) {
  const id = await command("evidence");
  const logs = await waitUntil(() => call("electron_logs", { process: "all", limit: 100 }),
    ({ events }) =>
      events.some((event) => event.process === "main" &&
        event.message.includes(`FIXTURE_MAIN_LIFECYCLE ${run} ${id}`)) &&
      events.some((event) => event.process === "renderer" &&
        event.message.includes(`FIXTURE_RENDERER_READY ${run}`) && event.message !== previousMessage),
    "fresh evidence from both channels");
  return logs.events.findLast((event) => event.process === "renderer" &&
    event.message.includes(`FIXTURE_RENDERER_READY ${run}`)).message;
}

try {
  await client.request(requestId++, "initialize", {
    protocolVersion: "2025-03-26", capabilities: {},
    clientInfo: { name: "fixture-lifecycle", version: "1.0.0" },
  });
  client.notify("notifications/initialized", {});
  const mcpPid = client.child.pid;
  const first = await startFixture();
  const attached = await call("electron_attach", {
    mainUrl: first.mainUrl, rendererUrl: first.rendererUrl,
  });
  assert.equal(attached.main.online, true);
  assert.equal(attached.renderer.online, true);
  const oldTarget = attached.selectedTarget.id;
  const initialMessage = await evidence(first.run);

  await call("electron_logs", { clear: true });
  await command("reload");
  const reloadMessage = await evidence(first.run, initialMessage);
  assert.notEqual(reloadMessage, initialMessage);
  const reloaded = await call("electron_status");
  assert.equal(reloaded.renderer.online, true);
  assert.equal(reloaded.selectedTarget.id, oldTarget);
  console.log("Lifecycle verified: renderer reload with fresh evidence");

  await call("electron_logs", { clear: true });
  await command("recreate");
  await waitUntil(() => call("electron_status"),
    (status) => !status.renderer.online && !status.selectedTarget && status.targets.length === 0,
    "old renderer disconnected");
  // Without clearSelection the switch to the new window is reported, so evidence is not silently from another page.
  const replacement = await call("electron_targets", {});
  assert.ok(replacement.selectedTarget);
  assert.notEqual(replacement.selectedTarget.id, oldTarget);
  assert.equal(replacement.warnings[0]?.code, "TARGET_CHANGED", JSON.stringify(replacement));
  assert.equal(replacement.warnings[0].details.previous.id, oldTarget);
  await evidence(first.run, reloadMessage);
  console.log("Lifecycle verified: BrowserWindow replacement and target reselection");

  await stopChild(fixture, () => fixture.send({ command: "quit" }));
  assert.equal(fixture.exitCode, 0, "fixture restart must follow a graceful exit");
  await waitUntil(() => call("electron_status"),
    (status) => !status.main.online && !status.renderer.online && !status.selectedTarget,
    "both sessions disconnected after Electron exit");
  await waitUntil(async () => Promise.all([discovery(first.mainPort), discovery(first.rendererPort)]),
    (responses) => responses.every((response) => response === undefined), "old ports released");
  await call("electron_logs", { clear: true });
  const restarted = await startFixture();
  const recovered = await call("electron_attach", {
    mainUrl: restarted.mainUrl, rendererUrl: restarted.rendererUrl, clearSelection: true,
  });
  assert.equal(recovered.main.online, true);
  assert.equal(recovered.renderer.online, true);
  assert.notEqual(recovered.selectedTarget.id, replacement.selectedTarget.id);
  await evidence(restarted.run);
  assert.equal(client.child.pid, mcpPid, "recovery must use the original MCP process");
  const logs = await call("electron_logs", { process: "all" });
  assert.equal(logs.events.some((event) => event.message.includes(first.run)), false);
  console.log("Lifecycle verified: Electron restart, new endpoints and fresh evidence in the same MCP");
} finally {
  await client.close();
  if (fixture) await stopChild(fixture, () => fixture.send({ command: "quit" }));
}
