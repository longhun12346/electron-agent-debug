import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const fixtureRoot = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(fixtureRoot, "../..");
const blockedEnvironment = { ...process.env };
delete blockedEnvironment.ELECTRON_DEBUG_MAIN_URL;
delete blockedEnvironment.ELECTRON_DEBUG_CDP_URL;

class McpClient {
  constructor() {
    this.child = spawn(process.execPath, [path.join(projectRoot, "dist", "index.js")], {
      cwd: projectRoot,
      stdio: ["pipe", "pipe", "inherit"],
      env: blockedEnvironment,
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
        if (typeof message.id !== "number") continue;
        const waiter = this.waiters.get(message.id);
        if (waiter) {
          this.waiters.delete(message.id);
          waiter(message);
        }
      }
    });
  }

  request(id, method, params) {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.waiters.delete(id);
        reject(new Error(`MCP request timeout: ${method}`));
      }, 15_000);
      this.waiters.set(id, (message) => {
        clearTimeout(timeout);
        resolve(message);
      });
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }

  notify(method, params) {
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
  }

  close() {
    this.child.kill();
  }
}

function structuredData(response) {
  const text = response?.result?.content?.[0]?.text;
  if (!text) {
    throw new Error(`MCP 返回缺少结构化内容：${JSON.stringify(response)}`);
  }
  return JSON.parse(text);
}

const client = new McpClient();
try {
  await client.request(1, "initialize", {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "fixture-blocked-smoke", version: "1.0.0" },
  });
  client.notify("notifications/initialized", {});
  const response = await client.request(2, "tools/call", {
    name: "electron_attach",
    arguments: {},
  });
  const data = structuredData(response);
  if (data.ok !== false || data.error?.code !== "ENDPOINT_NOT_CONFIGURED") {
    throw new Error(`缺少 endpoint 时未返回预期 BLOCKED 证据：${JSON.stringify(data)}`);
  }
  console.log(JSON.stringify({ conclusion: "BLOCKED", response }, null, 2));
} finally {
  client.close();
}
