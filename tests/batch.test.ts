import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const fakeApp = path.join(here, "helpers", "fake-electron-app.cjs");
const launcher = path.join(root, "skill", "electron-debug", "runtime", "launch.cjs");

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

function runBatch(entry: string, input: string): Promise<{ code: number | null; output: BatchOutput }> {
  const env = { ...process.env };
  for (const name of Object.keys(env)) {
    if (name.startsWith("ELECTRON_DEBUG_")) delete env[name];
  }
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [entry, "--run"], { stdio: ["pipe", "pipe", "pipe"], env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => {
      try {
        resolve({ code, output: JSON.parse(stdout) as BatchOutput });
      } catch {
        reject(new Error(`invalid batch output: ${stdout}\n${stderr}`));
      }
    });
    child.stdin.end(input);
  });
}

test("batch mode runs ordered tool calls in one session without registering an MCP", { timeout: 30_000 }, async (t) => {
  const mainPort = await freePort();
  const rendererPort = await freePort();
  const app = spawn(process.execPath, [
    fakeApp, `--inspect=${mainPort}`, `--remote-debugging-port=${rendererPort}`,
  ], { stdio: "ignore" });
  t.after(() => { app.kill(); });

  const attach = {
    tool: "electron_attach",
    arguments: { mainUrl: `http://127.0.0.1:${mainPort}`, rendererUrl: `http://127.0.0.1:${rendererPort}` },
  };
  let last: BatchOutput | undefined;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const { output } = await runBatch("dist/index.js", JSON.stringify([attach]));
    last = output;
    const data = output.results[0]?.result?.data;
    if (data?.main?.online && data?.renderer?.online) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal(last?.results[0]?.result?.data?.renderer?.online, true, JSON.stringify(last));

  const { code, output } = await runBatch("dist/index.js", JSON.stringify([
    attach,
    { tool: "electron_evaluate", arguments: { scope: "renderer", expression: "document.title" } },
    { tool: "electron_status" },
  ]));
  assert.equal(code, 0, JSON.stringify(output));
  assert.equal(output.ok, true);
  assert.deepEqual(output.results.map((entry) => entry.tool), ["electron_attach", "electron_evaluate", "electron_status"]);
  assert.equal(output.results[1]?.result?.data?.value, "renderer:document.title");
});

test("batch mode stops at the first failing step unless continueOnError is set", { timeout: 30_000 }, async () => {
  const stopped = await runBatch("dist/index.js", JSON.stringify([
    { tool: "electron_evaluate", arguments: { scope: "renderer", expression: "1" } },
    { tool: "electron_status" },
  ]));
  assert.equal(stopped.code, 1);
  assert.equal(stopped.output.ok, false);
  assert.equal(stopped.output.results[0]?.ok, false);
  assert.equal(stopped.output.results[0]?.result?.error?.code, "SESSION_DISCONNECTED");
  assert.equal(stopped.output.results[1]?.skipped, true);

  const continued = await runBatch("dist/index.js", JSON.stringify([
    { tool: "electron_evaluate", arguments: { scope: "renderer", expression: "1" }, continueOnError: true },
    { tool: "electron_status" },
  ]));
  assert.equal(continued.code, 1);
  assert.equal(continued.output.results[1]?.ok, true);
});

test("batch mode reports unknown tools, invalid arguments and malformed input", { timeout: 30_000 }, async () => {
  const unknown = await runBatch("dist/index.js", JSON.stringify([{ tool: "electron_launch" }]));
  assert.equal(unknown.output.results[0]?.result?.error?.code, "INVALID_ARGUMENT");

  const invalid = await runBatch("dist/index.js", JSON.stringify([
    { tool: "electron_evaluate", arguments: { scope: "other" } },
  ]));
  assert.equal(invalid.output.results[0]?.result?.error?.code, "INVALID_ARGUMENT");

  const malformed = await runBatch("dist/index.js", "not json");
  assert.equal(malformed.code, 1);
  assert.equal(malformed.output.results[0]?.result?.error?.code, "INVALID_ARGUMENT");
});

test("the packaged launcher accepts --run after integrity verification", { timeout: 30_000 }, async () => {
  const { code, output } = await runBatch(launcher, JSON.stringify([{ tool: "electron_status" }]));
  assert.equal(code, 0, JSON.stringify(output));
  assert.equal(output.results[0]?.tool, "electron_status");
});
