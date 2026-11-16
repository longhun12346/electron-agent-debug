import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { McpProcess } from "./helpers/mcp-process.js";

const fakeApp = path.join(path.dirname(fileURLToPath(import.meta.url)), "helpers", "fake-electron-app.cjs");

interface ToolResponse {
  result?: { isError?: boolean; structuredContent?: { ok?: boolean; error?: { code?: string }; data?: Record<string, any> } };
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolve(port));
    });
  });
}

async function startClient(t: test.TestContext, env: NodeJS.ProcessEnv) {
  const client = new McpProcess({ env });
  t.after(() => client.close());
  await client.request(1, "initialize", {
    protocolVersion: "2025-03-26", capabilities: {},
    clientInfo: { name: "attach-contract", version: "1.0.0" },
  });
  client.notify("notifications/initialized", {});
  let id = 1;
  return async (name: string, args: Record<string, unknown> = {}): Promise<ToolResponse> =>
    await client.request(++id, "tools/call", { name, arguments: args }) as ToolResponse;
}

test("MCP attaches to a running app and evaluates over stdio", { timeout: 30_000 }, async (t) => {
  const mainPort = await freePort();
  const rendererPort = await freePort();
  const app = spawn(process.execPath, [
    fakeApp, `--inspect=${mainPort}`, `--remote-debugging-port=${rendererPort}`,
  ], { stdio: "ignore" });
  t.after(() => { app.kill(); });

  const call = await startClient(t, {});
  const attachArgs = { mainUrl: `http://127.0.0.1:${mainPort}`, rendererUrl: `http://127.0.0.1:${rendererPort}` };
  let attached: ToolResponse = {};
  for (let attempt = 0; attempt < 50; attempt += 1) {
    attached = await call("electron_attach", attachArgs);
    const data = attached.result?.structuredContent?.data;
    if (data?.main?.online && data?.renderer?.online) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal(attached.result?.structuredContent?.data?.renderer?.online, true, JSON.stringify(attached));

  const evaluated = await call("electron_evaluate", { scope: "renderer", expression: "document.title" });
  assert.equal(evaluated.result?.structuredContent?.data?.value, "renderer:document.title");

  const logs = await call("electron_logs", { process: "renderer" });
  assert.ok((logs.result?.structuredContent?.data?.events as Array<{ message: string }>).some((event) =>
    event.message.includes("renderer ready")));
});

test("MCP refuses evaluate when the host sets ELECTRON_DEBUG_ALLOW_EVAL=0", { timeout: 30_000 }, async (t) => {
  const call = await startClient(t, { ELECTRON_DEBUG_ALLOW_EVAL: "0" });
  const refused = await call("electron_evaluate", { scope: "main", expression: "1" });
  assert.equal(refused.result?.isError, true);
  assert.equal(refused.result?.structuredContent?.error?.code, "EVALUATION_NOT_ALLOWED");
});
