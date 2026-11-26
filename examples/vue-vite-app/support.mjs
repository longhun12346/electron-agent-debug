import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

export const appRoot = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(appRoot, "../..");
export const electronVite = path.join(appRoot, "node_modules/electron-vite/bin/electron-vite.js");

export async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  await new Promise((resolve) => server.close(resolve));
  if (!address || typeof address === "string") throw new Error("port allocation failed");
  return String(address.port);
}

export async function waitUntil(read, accept, label, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await read();
    if (accept(last)) return last;
    await delay(50);
  }
  throw new Error(`${label} timeout; last observation: ${JSON.stringify(last)}`);
}

export async function discovery(port) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/json/list`, {
      signal: AbortSignal.timeout(500),
    });
    return response.ok ? await response.json() : undefined;
  } catch {
    return undefined;
  }
}

export async function stopChild(child, graceful) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit");
  graceful?.();
  if (!graceful) child.kill();
  try {
    await once(child, "exit", { signal: AbortSignal.timeout(3_000) });
  } catch {
    child.kill("SIGKILL");
  }
  await exited;
}

export class McpClient {
  constructor(overrides = {}) {
    const env = { ...process.env };
    for (const key of Object.keys(env)) {
      if (key.startsWith("ELECTRON_DEBUG_")) delete env[key];
    }
    const entry = process.env.ELECTRON_DEBUG_TEST_MCP_ENTRY
      ? path.resolve(process.env.ELECTRON_DEBUG_TEST_MCP_ENTRY) : path.join(root, "dist/index.js");
    this.child = spawn(process.execPath, [entry], {
      cwd: path.dirname(entry),
      stdio: ["pipe", "pipe", "inherit"], env: { ...env, ...overrides },
    });
    this.buffer = "";
    this.waiters = new Map();
    this.child.on("error", (error) => this.fail(error));
    this.child.on("exit", (code, signal) =>
      this.fail(new Error(`MCP exited: ${code ?? signal}`)));
    this.child.stdin.on("error", (error) => this.fail(error));
    this.child.stdout.on("data", (chunk) => {
      this.buffer += chunk.toString();
      const lines = this.buffer.split("\n");
      this.buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const message = JSON.parse(line);
          const pending = this.waiters.get(message.id);
          if (pending) {
            clearTimeout(pending.timer);
            this.waiters.delete(message.id);
            pending.resolve(message);
          }
        } catch (error) { this.fail(error); }
      }
    });
  }

  fail(error) {
    this.failure = error;
    for (const waiter of this.waiters.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    this.waiters.clear();
  }

  request(id, method, params, timeoutMs = 5_000) {
    if (this.failure) return Promise.reject(this.failure);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters.delete(id);
        reject(new Error(`MCP request timeout: ${method}`));
      }, timeoutMs);
      this.waiters.set(id, { resolve, reject, timer });
      this.notify(method, params, id);
    });
  }

  notify(method, params, id) {
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  }

  async close() {
    await stopChild(this.child, () => this.child.stdin.end());
  }
}

export function structuredData(response, label) {
  const result = response?.result?.structuredContent;
  if (response.error || !result?.ok) {
    throw new Error(`${label} failed: ${JSON.stringify(response)}`);
  }
  return result.data;
}

// ---- Running the app ----------------------------------------------------------------------------------------------

export function stopTree(child) {
  if (child.exitCode !== null || child.pid === undefined) return Promise.resolve();
  const exited = new Promise((resolve) => child.once("exit", resolve));
  if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
  else process.kill(-child.pid, "SIGKILL");
  return exited;
}

const builds = new Map();
// The files `electron-vite build` writes, once per run. The ES module variant goes to its own folder.
export function ensureBuilt({ esm = false } = {}) {
  if (!builds.has(esm)) {
    const args = [electronVite, "build", ...(esm ? ["--outDir", "out-esm"] : [])];
    const build = spawnSync(process.execPath, args, { cwd: appRoot, encoding: "utf8", env: { ...process.env, APP_ESM: String(esm) } });
    assert.equal(build.status, 0, `electron-vite build failed:\n${build.stdout}\n${build.stderr}`);
    builds.set(esm, true);
  }
}

/**
 * Starts the task board on fresh loopback ports and waits until the main inspector and a renderer page are listed.
 * Dev: through the electron-vite dev server (files watched, hot updates, Electron restarted on main changes).
 * Built: the build output started by Electron itself, the way a packaged app loads its files.
 */
export async function startApp({ fault = "", store, files = {}, windowless = false, built = false, esm = false, noise = 0, indexerPort, electronArgs = [], env: extraEnv = {} } = {}) {
  const [mainPort, rendererPort] = [await freePort(), await freePort()];
  const dataDir = mkdtempSync(path.join(tmpdir(), "vue-app-"));
  if (store !== undefined) writeFileSync(path.join(dataDir, "tasks.json"), store);
  for (const [name, content] of Object.entries(files)) writeFileSync(path.join(dataDir, name), content);
  const noSandbox = process.env.TEST_ELECTRON_NO_SANDBOX === "true";
  let command;
  let args;
  // Electron's package downloads the binary the first time it is required (a plain `npm ci` does not), and the dev
  // server only looks for the downloaded file, so make sure it is there before anything starts.
  const electronPath = createRequire(path.join(appRoot, "package.json"))("electron");
  if (built) {
    ensureBuilt({ esm });
    command = electronPath;
    // The ES module build is started by its entry file; the default one by the app folder and its package.json.
    const entry = esm ? path.join(appRoot, "out-esm/main/index.mjs") : appRoot;
    args = [`--inspect=${mainPort}`, `--remote-debugging-port=${rendererPort}`, ...(noSandbox ? ["--no-sandbox"] : []), ...electronArgs, entry];
  } else {
    command = process.execPath;
    args = [electronVite, "dev", "--watch", "--inspect", mainPort, "--remoteDebuggingPort", rendererPort, ...(noSandbox ? ["--noSandbox"] : [])];
  }
  const env = { ...process.env, APP_DATA_DIR: dataDir, APP_FAULT: fault, APP_NOISE: String(noise), ...extraEnv };
  if (indexerPort) env.APP_INDEXER_INSPECT_PORT = String(indexerPort);
  const child = spawn(command, args, { cwd: appRoot, env, stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32" });
  let output = "";
  for (const stream of [child.stdout, child.stderr]) stream.on("data", (chunk) => { output += chunk; });
  const exited = new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
  const wantsPage = (targets) => targets?.some((target) => target.type === "page"
    && target.url.startsWith(built ? "file://" : "http://localhost"));
  try {
    await waitUntil(() => discovery(mainPort), Array.isArray, "main discovery", 60_000);
    // When the window cannot be created there is never a page, only the renderer's debugging port.
    if (windowless) await waitUntil(() => discovery(rendererPort), Array.isArray, "renderer discovery", 60_000);
    else await waitUntil(() => discovery(rendererPort), wantsPage, "renderer page", 60_000);
  } catch (error) {
    await stopTree(child);
    throw new Error(`${error.message}\n--- app output ---\n${output.slice(-3000)}`);
  }
  return {
    child,
    exited,
    dataDir,
    mainPort,
    rendererPort,
    indexerPort,
    mainUrl: `http://127.0.0.1:${mainPort}`,
    rendererUrl: `http://127.0.0.1:${rendererPort}`,
    output: () => output,
    stop: async () => {
      await stopTree(child);
      // Windows keeps the profile files locked for a moment after the processes are gone; a leftover temp folder is harmless.
      try { rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }); } catch { /* ignore */ }
    },
  };
}

/** Runs `run(session)` against a started app and one MCP client, and cleans both up. */
export async function withSession(options, run) {
  const { mcpEnv = {}, ...appOptions } = options;
  const app = await startApp(appOptions);
  const clients = [];
  let requestId = 1;
  async function newClient(env = mcpEnv) {
    const client = new McpClient(env);
    clients.push(client);
    await client.request(requestId++, "initialize", {
      protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "vue-vite-smoke", version: "1.0.0" },
    });
    client.notify("notifications/initialized", {});
    return client;
  }
  const bind = (client) => {
    const raw = (tool, toolArguments = {}) =>
      client.request(requestId++, "tools/call", { name: tool, arguments: toolArguments }, 30_000);
    const call = async (tool, toolArguments) => structuredData(await raw(tool, toolArguments), tool);
    const session = {
      app, client, raw, call,
      // A tool call that must fail: returns the error.
      async failure(tool, toolArguments) {
        const response = await raw(tool, toolArguments);
        assert.equal(response.result?.isError, true, `${tool} should fail: ${JSON.stringify(response)}`);
        return response.result.structuredContent.error;
      },
      attach: (extra = {}) => call("electron_attach", { mainUrl: app.mainUrl, rendererUrl: app.rendererUrl, ...extra }),
      evaluate: async (scope, expression, extra = {}) => (await call("electron_evaluate", { scope, expression, ...extra })).value,
      evaluateFull: (scope, expression, extra = {}) => call("electron_evaluate", { scope, expression, ...extra }),
      renderer: (expression, timeoutMs = 20_000) =>
        call("electron_wait_for", { expression: { scope: "renderer", expression }, timeoutMs }),
      logs: async (extra = {}) => (await call("electron_logs", { process: "all", limit: 500, ...extra })).events,
      // The first event of `process` after `seq` that contains `contains`.
      async eventAfter(seq, process, contains, timeoutMs = 10_000) {
        return (await call("electron_wait_for", { log: { contains, process, afterSeq: seq }, timeoutMs })).event;
      },
      // Runs a statement block in the main process with `electron` in scope.
      electron: (body) => session.evaluate("main", `(async () => { const electron = process.mainModule.require('electron'); ${body} })()`),
    };
    return session;
  };
  try {
    const session = bind(await newClient());
    session.newSession = async (env) => bind(await newClient(env));
    return await run(session);
  } catch (error) {
    error.message += `\n--- app output ---\n${app.output().slice(-2000)}`;
    throw error;
  } finally {
    for (const client of clients) await client.close();
    await app.stop();
  }
}

export const taskCount = (n) => `document.querySelectorAll('li.task').length === ${n}`;
