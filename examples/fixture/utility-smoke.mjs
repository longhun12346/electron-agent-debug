import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { McpClient, structuredData, freePort, discovery, waitUntil, stopChild } from "./test-support.mjs";

// Real Electron: attach to a running utility process through the main process, without a pre-opened inspector.
const electron = createRequire(import.meta.url)("electron");
const fixtureRoot = path.dirname(fileURLToPath(import.meta.url));
const name = "fixture-utility";
const [mainPort, rendererPort, utilityPort] = [await freePort(), await freePort(), await freePort()];
const run = randomUUID();
const endpoints = {
  mainUrl: `http://127.0.0.1:${mainPort}`,
  rendererUrl: `http://127.0.0.1:${rendererPort}`,
};

const args = [`--inspect=${mainPort}`, `--remote-debugging-port=${rendererPort}`, fixtureRoot];
if (process.env.FIXTURE_ELECTRON_NO_SANDBOX === "true") args.unshift("--no-sandbox");
const env = {
  ...process.env,
  FIXTURE_RUN_ID: run,
  FIXTURE_RENDERER_PORT: rendererPort,
  FIXTURE_UTILITY: "true",
  FIXTURE_UTILITY_PORT: utilityPort,
};
delete env.FIXTURE_FAULT;
const fixture = spawn(electron, args, { stdio: ["ignore", "inherit", "inherit", "ipc"], env });

let requestId = 1;
async function call(client, tool, toolArguments = {}) {
  // Opening the inspector polls listening ports for a few seconds.
  return structuredData(await client.request(requestId++, "tools/call", {
    name: tool, arguments: toolArguments,
  }, 30_000), tool);
}

async function connect(overrides) {
  const client = new McpClient(overrides);
  await client.request(requestId++, "initialize", {
    protocolVersion: "2025-03-26", capabilities: {},
    clientInfo: { name: "fixture-utility-smoke", version: "1.0.0" },
  });
  client.notify("notifications/initialized", {});
  return client;
}

const codes = (result) => result.errors.map((error) => error.code);

try {
  await Promise.all([
    waitUntil(() => discovery(mainPort), Array.isArray, "main discovery"),
    waitUntil(() => discovery(rendererPort),
      (targets) => targets?.some((target) => target.type === "page"), "renderer discovery"),
  ]);
  assert.equal(await discovery(utilityPort), undefined, "utility inspector must start closed");

  const client = await connect();
  try {
    const base = await call(client, "electron_attach", endpoints);
    assert.ok(base.main.online && base.renderer.online, JSON.stringify(base));

    // An unknown name lists the candidates; poll it until the forked process is registered.
    const missing = await waitUntil(
      () => call(client, "electron_attach", { utility: "fixture-missing" }),
      (result) => result.errors[0]?.details?.candidates?.some((item) => item.name === name),
      "utility process registration",
    );
    assert.deepEqual(codes(missing), ["UTILITY_NOT_FOUND"]);
    assert.equal(missing.utility.online, false);
    assert.ok(missing.main.online && missing.renderer.online, JSON.stringify(missing));

    const disabled = await connect({ ELECTRON_DEBUG_ALLOW_EVAL: "0" });
    try {
      const refused = await call(disabled, "electron_attach", { ...endpoints, utility: name });
      assert.deepEqual(codes(refused), ["EVALUATION_NOT_ALLOWED"]);
      assert.equal(refused.utility.online, false);
    } finally {
      await disabled.close();
    }
    assert.equal(await discovery(utilityPort), undefined, "a refused attach must not open the inspector");

    const attached = await call(client, "electron_attach", { utility: name });
    assert.deepEqual(attached.errors, [], JSON.stringify(attached));
    assert.ok(attached.utility.online, JSON.stringify(attached.utility));
    assert.ok(attached.main.online && attached.renderer.online, JSON.stringify(attached));
    const pid = Number(attached.utility.selectedTarget.id);
    assert.equal(attached.utility.selectedTarget.title, name);
    assert.equal(attached.utility.endpoint, `http://127.0.0.1:${utilityPort}`);

    const evaluate = async (scope, expression) =>
      (await call(client, "electron_evaluate", { scope, expression })).value;
    assert.equal(await evaluate("utility", "process.type"), "utility");
    assert.equal(await evaluate("utility", "process.pid"), pid);
    assert.equal(await evaluate("utility", "fixtureUtility.value"), "utility-ok");
    assert.equal(await evaluate("main", "process.type"), "browser");

    const { lastSeq } = await call(client, "electron_logs", { process: "utility" });
    const marker = randomUUID();
    assert.equal(await evaluate("utility", `fixtureUtility.evidence(${JSON.stringify(marker)})`), true);
    const waited = await call(client, "electron_wait_for", {
      log: { contains: marker, process: "utility", afterSeq: lastSeq }, timeoutMs: 5_000,
    });
    assert.equal(waited.event.process, "utility");
    assert.ok(waited.event.message.includes(`FIXTURE_UTILITY_EVIDENCE ${run}`), waited.event.message);
    const mainLogs = await call(client, "electron_logs", { process: "main", limit: 10_000 });
    assert.ok(!mainLogs.events.some((event) => event.message.includes(marker)),
      "utility evidence must not be attributed to main");

    const byPid = await call(client, "electron_attach", { utility: pid });
    assert.deepEqual(byPid.errors, [], JSON.stringify(byPid));
    assert.ok(byPid.utility.online && byPid.main.online && byPid.renderer.online, JSON.stringify(byPid));

    console.log(JSON.stringify({ platform: process.platform, utility: byPid.utility.selectedTarget }));
  } finally {
    await client.close();
  }
} finally {
  await stopChild(fixture, () => fixture.send({ command: "quit" }));
}
