import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const electron = require("electron");
const fixtureRoot = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(fixtureRoot, "../..");
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
  { stdio: "inherit", env: process.env },
);

async function waitForDiscovery(port, label) {
  const url = `${endpoint(port)}/json/list`;
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        return await response.json();
      }
    } catch {
      // The application may still be starting.
    }
    await delay(100);
  }
  throw new Error(`${label} discovery timeout`);
}

class McpClient {
  constructor() {
    this.child = spawn(process.execPath, [path.join(projectRoot, "dist", "index.js")], {
      stdio: ["pipe", "pipe", "inherit"],
      env: {
        ...process.env,
        ELECTRON_DEBUG_MAIN_URL: endpoint(mainPort),
        ELECTRON_DEBUG_CDP_URL: endpoint(rendererPort),
      },
    });
    this.buffer = "";
    this.waiters = new Map();
    this.child.stdout.on("data", (chunk) => {
      this.buffer += chunk.toString();
      const lines = this.buffer.split("\n");
      this.buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        const message = JSON.parse(line);
        if (typeof message.id === "number") {
          this.waiters.get(message.id)?.(message);
          this.waiters.delete(message.id);
        }
      }
    });
  }

  request(id, method, params) {
    const response = new Promise((resolve) => this.waiters.set(id, resolve));
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    return response;
  }

  notify(method, params) {
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
  }

  close() {
    this.child.kill();
  }
}

function structuredData(response, label) {
  if (response?.error) {
    throw new Error(`${label} returned JSON-RPC error: ${JSON.stringify(response.error)}`);
  }
  const value = response?.result?.structuredContent;
  if (!value?.ok) {
    throw new Error(`${label} returned diagnostic error: ${JSON.stringify(value)}`);
  }
  return value.data;
}

function expectedMessages(fault) {
  return {
    renderer: ["FIXTURE_RENDERER_FAILURE"],
    ipc: ["FIXTURE_IPC_CALL_FAILURE", "FIXTURE_IPC_HANDLER_FAILURE"],
  }[fault] ?? ["FIXTURE_RENDERER_READY"];
}

async function waitForExpectedLogs(client, fault, requestId) {
  const expected = expectedMessages(fault);
  const deadline = Date.now() + 5_000;
  let response;
  let data;

  while (Date.now() < deadline) {
    response = await client.request(requestId++, "tools/call", {
      name: "electron_logs",
      arguments: { process: "all", limit: 50 },
    });
    data = structuredData(response, "electron_logs");
    if (data.events?.some((event) =>
      expected.some((message) => event.message?.includes(message)),
    )) {
      return { response, data };
    }
    await delay(100);
  }

  return { response, data };
}

function assertSmokeResults(attachData, statusData, targetsData, logsData) {
  if (!attachData.main?.online) {
    throw new Error(`main session is not online: ${JSON.stringify(attachData.main)}`);
  }
  if (!statusData.main?.online) {
    throw new Error(`status does not report an online main session: ${JSON.stringify(statusData.main)}`);
  }

  const fault = process.env.FIXTURE_FAULT || "";
  if (fault === "main-window") {
    const mainFailure = logsData.events?.some((event) =>
      event.process === "main" && event.message?.includes("FIXTURE_MAIN_WINDOW_FAILURE"),
    );
    if (!mainFailure) {
      throw new Error("main-window fault did not produce the expected main-process evidence");
    }
    return;
  }

  if (!attachData.renderer?.online || !attachData.selectedTarget) {
    throw new Error(`renderer session or target is not online: ${JSON.stringify(attachData.renderer)}`);
  }
  if (!statusData.renderer?.online || !statusData.selectedTarget) {
    throw new Error(`status does not report an online renderer target: ${JSON.stringify(statusData.renderer)}`);
  }
  if (!targetsData.targets?.length || !targetsData.selectedTarget) {
    throw new Error(`electron_targets did not select a renderer target: ${JSON.stringify(targetsData)}`);
  }

  const evidence = logsData.events?.some((event) =>
    expectedMessages(fault).some((message) => event.message?.includes(message)),
  );
  if (!evidence) {
    throw new Error(`did not find expected fixture evidence: ${expectedMessages(fault).join(" or ")}`);
  }
}

try {
  await Promise.all([
    waitForDiscovery(mainPort, "main"),
    waitForDiscovery(rendererPort, "renderer"),
  ]);

  const client = new McpClient();
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
    assertSmokeResults(attachData, statusData, targetsData, logsData);
    console.log(JSON.stringify({ attach, status, targets, logs: logsResult.response }, null, 2));
  } finally {
    client.close();
  }
} finally {
  fixture.kill();
}
