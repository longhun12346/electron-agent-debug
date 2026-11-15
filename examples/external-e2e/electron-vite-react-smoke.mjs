import { spawn } from "node:child_process";
import { createServer } from "node:net";
import fs from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const currentRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const projectRoot = process.env.ELECTRON_E2E_PROJECT_ROOT;
const electronPath = process.env.ELECTRON_E2E_ELECTRON;
const expectedRendererLog =
  process.env.ELECTRON_E2E_EXPECT_RENDERER_LOG ?? "[Receive Main-process message]";
const reportPath = process.env.ELECTRON_E2E_REPORT;
const maxCommandOutputBytes = 256 * 1024;

function requireProjectRoot() {
  if (!projectRoot) {
    throw new Error("请提供 ELECTRON_E2E_PROJECT_ROOT");
  }
  return path.resolve(projectRoot);
}

async function ensureDirectory(directory, label) {
  const stats = await fs.stat(directory).catch(() => undefined);
  if (!stats?.isDirectory()) {
    throw new Error(`${label} 不存在或不是目录：${directory}`);
  }
}

async function ensureFile(file, label) {
  const stats = await fs.stat(file).catch(() => undefined);
  if (!stats?.isFile()) {
    throw new Error(`${label} 不存在或不是文件：${file}`);
  }
}

async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : undefined;
  await new Promise((resolve) => server.close(resolve));
  if (!port) {
    throw new Error("无法分配动态端口");
  }
  return port;
}

async function runCommand(command, args, cwd, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    const appendOutput = (chunk) => {
      if (output.length >= maxCommandOutputBytes) return;
      output += chunk.toString().slice(0, maxCommandOutputBytes - output.length);
    };
    child.stdout.on("data", (chunk) => {
      appendOutput(chunk);
    });
    child.stderr.on("data", (chunk) => {
      appendOutput(chunk);
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      resolve({ code, signal, output });
    });
  });
}

async function runBuild(root) {
  if (process.env.ELECTRON_E2E_SKIP_BUILD === "true") {
    return { skipped: true, code: 0, output: "" };
  }

  const vite = path.join(root, "node_modules", "vite", "bin", "vite.js");
  const result = await runCommand(process.execPath, [vite, "build", "--mode", "test"], root, process.env);
  if (result.code !== 0) {
    throw new Error(`外部项目构建失败：${result.code ?? result.signal}\n${result.output}`);
  }
  return { skipped: false, ...result };
}

async function ensureCurrentBuild() {
  const entry = path.join(currentRoot, "dist", "index.js");
  const existing = await fs.stat(entry).catch(() => undefined);
  if (existing?.isFile()) {
    return { built: false, output: "" };
  }

  const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
  const result = await runCommand(npmCommand, ["run", "build"], currentRoot, process.env);
  if (result.code !== 0) {
    throw new Error(`当前 MCP 构建失败：${result.code ?? result.signal}\n${result.output}`);
  }
  return { built: true, output: result.output };
}

async function waitForDiscovery(port, label, hasExpectedTarget) {
  const url = `http://127.0.0.1:${port}/json/list`;
  const deadline = Date.now() + 30_000;
  let lastError = "";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        const body = await response.json();
        if (Array.isArray(body) && hasExpectedTarget(body)) {
          return body;
        }
        lastError = "discovery 尚未返回预期 target";
      } else {
        lastError = `HTTP ${response.status}`;
      }
    } catch (error) {
      lastError = String(error);
    }
    await delay(200);
  }
  throw new Error(`${label} discovery 超时：${lastError}`);
}

class McpClient {
  constructor(root, env) {
    this.child = spawn(process.execPath, [path.join(root, "dist", "index.js")], {
      cwd: root,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.buffer = "";
    this.stderr = "";
    this.waiters = new Map();
    this.child.stderr.on("data", (chunk) => {
      this.stderr += chunk.toString();
    });
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
        reject(new Error(`MCP 请求超时：${method}`));
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

function structured(response, label) {
  if (response?.error) {
    throw new Error(`${label} 返回 JSON-RPC 错误：${JSON.stringify(response.error)}`);
  }
  const text = response?.result?.content?.[0]?.text;
  if (!text) {
    throw new Error(`${label} 没有返回结构化内容`);
  }
  return JSON.parse(text);
}

function assertResults(result) {
  const attach = result.tools.attach;
  const status = result.tools.status;
  const targets = result.tools.targets;
  const logs = result.tools.logs;

  if (!attach.ok || !attach.data?.main?.online || !attach.data?.renderer?.online) {
    throw new Error(`双通道 attach 失败：${JSON.stringify(attach)}`);
  }
  if (!attach.data.selectedTarget || attach.data.errors?.length) {
    throw new Error(`attach 没有得到有效 target：${JSON.stringify(attach)}`);
  }
  if (!status.ok || !status.data?.main?.online || !status.data?.renderer?.online) {
    throw new Error(`status 没有报告双通道在线：${JSON.stringify(status)}`);
  }
  if (!targets.ok || !targets.data?.selectedTarget || !targets.data.targets?.length) {
    throw new Error(`targets 没有返回选中的 page：${JSON.stringify(targets)}`);
  }
  const events = logs.data?.events ?? [];
  const hasMainConnection = events.some(
    (event) => event.process === "main" && event.kind === "connection",
  );
  const hasRendererConnection = events.some(
    (event) => event.process === "renderer" && event.kind === "connection",
  );
  const hasExpectedRendererLog = events.some(
    (event) => event.process === "renderer" && event.message?.includes(expectedRendererLog),
  );
  if (!hasMainConnection || !hasRendererConnection || !hasExpectedRendererLog) {
    throw new Error(`日志证据不完整：${JSON.stringify(logs)}`);
  }
}

async function terminate(child) {
  if (!child || child.exitCode !== null) return;
  child.kill();
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    delay(2_000),
  ]);
}

const root = requireProjectRoot();
await ensureDirectory(root, "外部项目目录");
await ensureDirectory(path.join(root, "node_modules"), "外部项目依赖目录");
await ensureDirectory(currentRoot, "当前项目目录");
const currentMcpBuild = await ensureCurrentBuild();

if (!electronPath) {
  throw new Error("请提供 ELECTRON_E2E_ELECTRON");
}
await ensureFile(path.resolve(electronPath), "Electron 可执行文件");

const mainPort = await freePort();
const rendererPort = await freePort();
const endpoint = (port) => `http://127.0.0.1:${port}`;
const build = await runBuild(root);
const app = spawn(
  path.resolve(electronPath),
  [
    `--inspect=${mainPort}`,
    `--remote-debugging-port=${rendererPort}`,
    ...(process.env.ELECTRON_E2E_NO_SANDBOX === "false" ? [] : ["--no-sandbox"]),
    ".",
  ],
  {
    cwd: root,
    env: { ...process.env, NODE_ENV: "development" },
    stdio: ["ignore", "pipe", "pipe"],
  },
);
let appOutput = "";
app.stdout.on("data", (chunk) => {
  appOutput += chunk.toString();
});
app.stderr.on("data", (chunk) => {
  appOutput += chunk.toString();
});

const client = new McpClient(currentRoot, {
  ...process.env,
  ELECTRON_DEBUG_MAIN_URL: endpoint(mainPort),
  ELECTRON_DEBUG_CDP_URL: endpoint(rendererPort),
});

const result = {
  projectRoot: root,
  currentMcpBuild,
  mainPort,
  rendererPort,
  build,
  discovery: {},
  tools: {},
};

try {
  result.discovery.main = await waitForDiscovery(
    mainPort,
    "主进程",
    (targets) => targets.some((target) => typeof target.webSocketDebuggerUrl === "string"),
  );
  result.discovery.renderer = await waitForDiscovery(
    rendererPort,
    "renderer",
    (targets) => targets.some((target) => target.type === "page"),
  );

  result.tools.initialize = await client.request(1, "initialize", {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "electron-vite-react-e2e", version: "1.0.0" },
  });
  client.notify("notifications/initialized", {});
  result.tools.attach = structured(
    await client.request(2, "tools/call", {
      name: "electron_attach",
      arguments: {},
    }),
    "electron_attach",
  );
  await delay(750);
  result.tools.status = structured(
    await client.request(3, "tools/call", {
      name: "electron_status",
      arguments: {},
    }),
    "electron_status",
  );
  result.tools.targets = structured(
    await client.request(4, "tools/call", {
      name: "electron_targets",
      arguments: {},
    }),
    "electron_targets",
  );
  result.tools.logs = structured(
    await client.request(5, "tools/call", {
      name: "electron_logs",
      arguments: { process: "all", limit: 100 },
    }),
    "electron_logs",
  );
  assertResults(result);
  result.diagnosticConclusion = "PASS";
} catch (error) {
  result.diagnosticConclusion = "FAIL";
  result.error = String(error);
  throw error;
} finally {
  result.appOutput = appOutput.slice(-12_000);
  result.mcpStderr = client.stderr.slice(-4_000);
  client.close();
  await terminate(app);
  if (reportPath) {
    await fs.writeFile(path.resolve(reportPath), `${JSON.stringify(result, null, 2)}\n`, "utf8");
  }
  console.log(JSON.stringify(result, null, 2));
}
