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

interface ToolsOutput {
  ok: boolean;
  tools?: Array<{ name: string; description: string; inputSchema: any }>;
  error?: { code: string; message: string };
}

function listTools(entry: string, ...extra: string[]): Promise<{ code: number | null; output: ToolsOutput; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [entry, "--tools", ...extra], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => {
      try {
        resolve({ code, output: stdout.trim() === "" ? { ok: false } : JSON.parse(stdout) as ToolsOutput, stderr });
      } catch {
        reject(new Error(`invalid --tools output: ${stdout}\n${stderr}`));
      }
    });
  });
}

test("--tools lists every tool with its input as JSON Schema, so batch callers need not guess", { timeout: 30_000 }, async () => {
  const { code, output } = await listTools("dist/index.js");
  assert.equal(code, 0);
  assert.equal(output.ok, true);
  const names = output.tools!.map((tool) => tool.name);
  assert.deepEqual(names, [
    "electron_attach", "electron_status", "electron_targets", "electron_logs",
    "electron_evaluate", "electron_wait_for", "electron_screenshot", "electron_dom_snapshot",
  ]);
  for (const tool of output.tools!) {
    assert.ok(tool.description.length > 0, `${tool.name} has no description`);
    assert.equal(tool.inputSchema.type, "object", tool.name);
    assert.equal(tool.inputSchema.$schema, undefined, "the draft marker is noise");
  }
  const text = JSON.stringify(output);
  assert.equal(text.includes("9007199254740991"), false, "the safe-integer bounds are noise");

  // The mistake a real host made: wait_for takes an object under `expression`, not a string.
  const waitFor = output.tools!.find((tool) => tool.name === "electron_wait_for")!;
  assert.equal(waitFor.inputSchema.properties.expression.type, "object");
  assert.deepEqual(waitFor.inputSchema.properties.expression.required, ["scope", "expression"]);
  assert.deepEqual(waitFor.inputSchema.properties.log.required, ["contains"]);
  const logs = output.tools!.find((tool) => tool.name === "electron_logs")!;
  assert.equal(logs.inputSchema.properties.sinceAttach.type, "boolean");
  const evaluate = output.tools!.find((tool) => tool.name === "electron_evaluate")!;
  assert.deepEqual(evaluate.inputSchema.properties.scope.enum, ["main", "renderer", "utility"]);
});

test("--tools takes any number of tool names, in the order asked, and refuses unknown ones", { timeout: 30_000 }, async () => {
  const one = await listTools("dist/index.js", "electron_wait_for");
  assert.equal(one.code, 0);
  assert.deepEqual(one.output.tools?.map((tool) => tool.name), ["electron_wait_for"]);

  // A real host asked for two at once and got a usage error; it must get both, as asked, once each.
  const several = await listTools("dist/index.js", "electron_logs", "electron_attach", "electron_logs");
  assert.equal(several.code, 0);
  assert.deepEqual(several.output.tools?.map((tool) => tool.name), ["electron_logs", "electron_attach"]);

  const unknown = await listTools("dist/index.js", "electron_launch");
  assert.equal(unknown.code, 1);
  assert.equal(unknown.output.ok, false);
  assert.equal(unknown.output.error?.code, "INVALID_ARGUMENT");
  assert.match(unknown.output.error?.message ?? "", /electron_attach/u, "the message lists the valid names");

  // One wrong name among right ones must not return a partial listing; every unknown name is reported.
  const mixed = await listTools("dist/index.js", "electron_status", "electron_nope", "electron_nada");
  assert.equal(mixed.code, 1);
  assert.equal(mixed.output.tools, undefined);
  assert.match(mixed.output.error?.message ?? "", /electron_nope, electron_nada/u);
});

test("the packaged launcher accepts --tools after integrity verification and rejects unknown modes", { timeout: 30_000 }, async () => {
  const packaged = await listTools(launcher, "electron_status", "electron_logs");
  assert.equal(packaged.code, 0, packaged.stderr);
  assert.deepEqual(packaged.output.tools?.map((tool) => tool.name), ["electron_status", "electron_logs"]);

  const refused = await new Promise<{ code: number | null; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, [launcher, "--list"], { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stderr }));
  });
  assert.equal(refused.code, 1);
  assert.match(refused.stderr, /--tools \[tool-name \.\.\.\]/u);
});
