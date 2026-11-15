import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { McpClient, structuredData, discovery, waitUntil, stopChild } from "./test-support.mjs";
import { assertSmokeResults, hasExpectedEvidence } from "./smoke-assertions.mjs";

const require = createRequire(import.meta.url);
const electron = require("electron");
const fixtureRoot = path.dirname(fileURLToPath(import.meta.url));
const mainPort = process.env.FIXTURE_MAIN_PORT;
const rendererPort = process.env.FIXTURE_RENDERER_PORT;

if (!mainPort || !rendererPort) {
  throw new Error("请提供 FIXTURE_MAIN_PORT 和 FIXTURE_RENDERER_PORT");
}

const endpoint = (port) => `http://127.0.0.1:${port}`;
const electronArgs = [
  `--inspect=${mainPort}`,
  `--remote-debugging-port=${rendererPort}`,
];
if (process.env.FIXTURE_ELECTRON_NO_SANDBOX === "true") {
  electronArgs.unshift("--no-sandbox");
}
const fixture = spawn(
  electron,
  [...electronArgs, fixtureRoot],
  { stdio: ["inherit", "inherit", "inherit", "ipc"], env: process.env },
);

async function waitForDiscovery(port, label) {
  return waitUntil(() => discovery(port), (targets) => Array.isArray(targets), label);
}

async function waitForExpectedLogs(client, fault, requestId) {
  const deadline = Date.now() + 5_000;
  let response;
  let data;

  while (Date.now() < deadline) {
    response = await client.request(requestId++, "tools/call", {
      name: "electron_logs",
      arguments: { process: "all", limit: 50 },
    });
    data = structuredData(response, "electron_logs");
    if (hasExpectedEvidence(data.events, fault)) {
      return { response, data };
    }
    await delay(100);
  }

  return { response, data };
}

try {
  await Promise.all([
    waitForDiscovery(mainPort, "main"),
    waitForDiscovery(rendererPort, "renderer"),
  ]);

  const client = new McpClient({
    ELECTRON_DEBUG_MAIN_URL: endpoint(mainPort),
    ELECTRON_DEBUG_CDP_URL: endpoint(rendererPort),
  });
  try {
    await client.request(1, "initialize", {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "fixture-smoke", version: "1.0.0" },
    });
    client.notify("notifications/initialized", {});
    const attach = await client.request(2, "tools/call", {
      name: "electron_attach",
      arguments: {},
    });
    const status = await client.request(3, "tools/call", {
      name: "electron_status",
      arguments: {},
    });
    const targets = await client.request(4, "tools/call", {
      name: "electron_targets",
      arguments: {},
    });
    const logsResult = await waitForExpectedLogs(client, process.env.FIXTURE_FAULT || "", 5);
    const attachData = structuredData(attach, "electron_attach");
    const statusData = structuredData(status, "electron_status");
    const targetsData = structuredData(targets, "electron_targets");
    const logsData = logsResult.data;
    assertSmokeResults(attachData, statusData, targetsData, logsData, process.env.FIXTURE_FAULT || "");
    console.log(JSON.stringify({ attach, status, targets, logs: logsResult.response }, null, 2));
  } finally {
    await client.close();
  }
} finally {
  await stopChild(fixture, () => fixture.send({ command: "quit" }));
}
