import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import test from "node:test";
import { McpProcess } from "./helpers/mcp-process.js";

interface BatchOutput {
  ok: boolean;
  results: Array<{ tool: string; ok?: boolean; skipped?: boolean; result?: any }>;
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

function runBatch(
  input: string,
  extraEnv: NodeJS.ProcessEnv = {},
): Promise<{ code: number | null; stdout: string; stderr: string; stdinError?: Error }> {
  const env = { ...process.env };
  for (const name of Object.keys(env)) {
    if (name.startsWith("ELECTRON_DEBUG_")) delete env[name];
  }
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["dist/index.js", "--run"], { stdio: ["pipe", "pipe", "pipe"], env: { ...env, ...extraEnv } });
    let stdout = "";
    let stderr = "";
    let stdinError: Error | undefined;
    child.stdin.on("error", (error) => { stdinError = error; });
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout, stderr, stdinError }));
    child.stdin.end(input);
  });
}

test("a batch whose attach reaches no channel fails, stops, and still lists the reasons", { timeout: 30_000 }, async () => {
  const port = await freePort();
  const steps = [
    { tool: "electron_attach", arguments: { mainUrl: `http://127.0.0.1:${port}` } },
    { tool: "electron_status" },
  ];
  const { code, stdout } = await runBatch(JSON.stringify(steps));
  const output = JSON.parse(stdout) as BatchOutput;
  assert.equal(code, 1);
  assert.equal(output.ok, false);
  assert.equal(output.results[0]?.ok, false);
  assert.equal(output.results[0]?.result?.ok, false);
  assert.ok(output.results[0]?.result?.error?.code, "the first error is reported");
  assert.ok(output.results[0]?.result?.data?.errors?.length > 0, "the per-channel reasons are kept");
  assert.equal(output.results[1]?.skipped, true, "later steps do not run on a dead connection");
});

test("an unrecognised ELECTRON_DEBUG_ALLOW_EVAL is reported as JSON by batch mode, not as a crash", { timeout: 30_000 }, async () => {
  const { code, stdout, stderr } = await runBatch(JSON.stringify([{ tool: "electron_status" }]), { ELECTRON_DEBUG_ALLOW_EVAL: "none" });
  const output = JSON.parse(stdout) as BatchOutput;
  assert.equal(code, 1);
  assert.equal(output.ok, false);
  assert.equal(output.results[0]?.result?.error?.code, "ENDPOINT_CONFIG_INVALID");
  assert.match(output.results[0]?.result?.error?.message, /ELECTRON_DEBUG_ALLOW_EVAL/u);
  assert.ok(stderr.length < 2_000, `stderr stays short, got ${stderr.length} characters`);
});

test("an invalid setting keeps the MCP server up and every tool says what is wrong", { timeout: 30_000 }, async (t) => {
  const client = new McpProcess({ env: { ELECTRON_DEBUG_REQUEST_TIMEOUT_MS: "5" } });
  t.after(() => client.close());
  await client.request(1, "initialize", {
    protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "config-error", version: "1.0.0" },
  });
  client.notify("notifications/initialized", {});
  const listed = await client.request(2, "tools/list", {});
  assert.equal(listed.result?.tools?.length, 10);
  const called = await client.request(3, "tools/call", { name: "electron_status", arguments: {} }) as {
    result?: { isError?: boolean; structuredContent?: { error?: { code?: string; message?: string; hint?: string } } };
  };
  assert.equal(called.result?.isError, true);
  assert.equal(called.result?.structuredContent?.error?.code, "ENDPOINT_CONFIG_INVALID");
  assert.match(called.result?.structuredContent?.error?.message ?? "", /ELECTRON_DEBUG_REQUEST_TIMEOUT_MS/u);
  assert.ok(called.result?.structuredContent?.error?.hint, "the error says how to fix it");
});

test("batch mode with an invalid setting reads a large input to the end instead of cutting the writer off", { timeout: 30_000 }, async () => {
  const input = `${" ".repeat(900_000)}${JSON.stringify([{ tool: "electron_status" }])}`;
  for (let round = 0; round < 3; round += 1) {
    const { code, stdout, stdinError } = await runBatch(input, { ELECTRON_DEBUG_ALLOW_EVAL: "none" });
    assert.equal(stdinError, undefined, `round ${round}: the writer must not get EPIPE`);
    assert.equal(code, 1);
    assert.equal((JSON.parse(stdout) as BatchOutput).results[0]?.result?.error?.code, "ENDPOINT_CONFIG_INVALID");
  }
});
