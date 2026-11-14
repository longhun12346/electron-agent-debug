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
const fixture = spawn(
  electron,
  [`--inspect=${mainPort}`, `--remote-debugging-port=${rendererPort}`, fixtureRoot],
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
    await delay(750);
    const status = await client.request(3, "tools/call", {
      name: "electron_status",
      arguments: {},
    });
    const logs = await client.request(4, "tools/call", {
      name: "electron_logs",
      arguments: { process: "all", limit: 50 },
    });
    console.log(JSON.stringify({ attach, status, logs }, null, 2));
  } finally {
    client.close();
  }
} finally {
  fixture.kill();
}
