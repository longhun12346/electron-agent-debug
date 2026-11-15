import { spawn } from "node:child_process";
import { once } from "node:events";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

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
    this.child = spawn(process.execPath, [path.join(root, "dist/index.js")], {
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

  request(id, method, params) {
    if (this.failure) return Promise.reject(this.failure);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters.delete(id);
        reject(new Error(`MCP request timeout: ${method}`));
      }, 5_000);
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
