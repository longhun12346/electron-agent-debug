import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { freePort, discovery, waitUntil, stopChild } from "../fixture/test-support.mjs";
import { hasExpectedEvidence } from "../fixture/smoke-assertions.mjs";

const [host, executable = host] = process.argv.slice(2);
if (!["codex", "claude"].includes(host)) {
  throw new Error("usage: node examples/host-e2e/smoke.mjs <codex|claude> [absolute-host-executable]");
}
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const temporary = await mkdtemp(path.join(tmpdir(), "electron host smoke "));
const trace = path.join(temporary, "mcp.jsonl");
let fixture;
let hostProcess;
let succeeded = false;
try {
  const version = (await promisify(execFile)(executable, ["--version"], { timeout: 10_000 })).stdout.trim();
  const mainPort = await freePort();
  const rendererPort = await freePort();
  const endpoints = {
    ELECTRON_DEBUG_MAIN_URL: `http://127.0.0.1:${mainPort}`,
    ELECTRON_DEBUG_CDP_URL: `http://127.0.0.1:${rendererPort}`,
  };
  const fixtureRoot = path.join(root, "examples/fixture");
  const electron = createRequire(path.join(fixtureRoot, "package.json"))("electron");
  const fixtureArgs = [`--inspect=${mainPort}`, `--remote-debugging-port=${rendererPort}`, fixtureRoot];
  if (process.env.FIXTURE_ELECTRON_NO_SANDBOX === "true") fixtureArgs.unshift("--no-sandbox");
  fixture = spawn(electron, fixtureArgs, {
    stdio: ["ignore", "ignore", "ignore", "ipc"],
    env: { ...process.env, FIXTURE_FAULT: "ipc", FIXTURE_RENDERER_PORT: rendererPort },
  });
  await Promise.all([waitUntil(() => discovery(mainPort), Array.isArray, "main discovery"),
    waitUntil(() => discovery(rendererPort), Array.isArray, "renderer discovery")]);
  const server = {
    command: process.execPath,
    args: [path.join(root, "examples/host-e2e/mcp-trace.mjs"), root, trace],
    env: {
      ...endpoints,
      ...(process.env.ELECTRON_DEBUG_TEST_MCP_ENTRY ? {
        ELECTRON_DEBUG_TEST_MCP_ENTRY: path.resolve(process.env.ELECTRON_DEBUG_TEST_MCP_ENTRY),
      } : {}),
    },
  };
  const skill = await readFile(path.join(root, "skill/electron-debug/SKILL.md"), "utf8");
  const prompt = `This is a bounded MCP host integration test. The test runner has already built the
MCP server and started the Electron fixture with Inspector and CDP; do not configure or launch anything.
Only use electron-debug MCP tools, no shell, files, browser, other servers, or subagents.
Call electron_attach (empty arguments; endpoints are configured), electron_status, electron_targets,
and electron_logs (process all, limit 100). Both main and renderer must be online, with a selected target.
The fixture intentionally triggers an IPC error: logs must include FIXTURE_IPC_HANDLER_FAILURE from main
and FIXTURE_IPC_CALL_FAILURE from renderer. Retry logs up to 3 times if needed.
Report whether both scoped error messages were observed, then stop. Do not fix the fixture.
The following is the installed Skill supplied explicitly for this test:\n\n${skill}`;
  let args;
  if (host === "claude") {
    const config = path.join(temporary, "mcp-config.json");
    await writeFile(config, JSON.stringify({ mcpServers: { "electron-debug": server } }));
    args = ["--print", "--strict-mcp-config", "--mcp-config", config,
      "--setting-sources", "", "--no-session-persistence", "--tools", "",
      "--allowedTools", "mcp__electron-debug__electron_attach,mcp__electron-debug__electron_status,mcp__electron-debug__electron_targets,mcp__electron-debug__electron_logs",
      "--output-format", "stream-json", "--verbose", prompt];
  } else {
    // Pre-authorize only this test server's four diagnostic calls for the noninteractive run.
    // This command-line override does not change the user's saved MCP policy.
    const toml = `{electron-debug={command=${JSON.stringify(server.command)},args=${JSON.stringify(server.args)},default_tools_approval_mode="approve",env={${Object.entries(endpoints).map(([key, value]) => `${key}=${JSON.stringify(value)}`).join(",")}}}}`;
    args = ["exec", "--ephemeral", "--skip-git-repo-check", "--json", "-C", temporary,
      "-c", `mcp_servers=${toml}`, "-c", 'approval_policy="never"', "-s", "read-only", prompt];
  }
  hostProcess = spawn(executable, args, {
    cwd: temporary, stdio: ["ignore", "pipe", "pipe"], env: process.env,
  });
  let output = "";
  let stderr = "";
  hostProcess.stdout.on("data", (chunk) => { output = (output + chunk).slice(-200_000); });
  hostProcess.stderr.on("data", (chunk) => { stderr = (stderr + chunk).slice(-20_000); });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("host integration timed out after 120s")), 120_000);
    hostProcess.once("error", (error) => { clearTimeout(timer); reject(error); });
    hostProcess.once("exit", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`${host} exited ${code}; inspect local host stderr`));
    });
  }).finally(async () => {
    await writeFile(path.join(temporary, "host-events.jsonl"), output);
    await writeFile(path.join(temporary, "host-stderr.log"), stderr);
  });
  const traffic = (await readFile(trace, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  const requests = traffic.filter(({ direction, message }) =>
    direction === "request" && message.method === "tools/call");
  const responses = new Map(traffic.filter(({ direction }) => direction === "response")
    .map(({ message }) => [message.id, message]));
  const tools = ["electron_attach", "electron_status", "electron_targets", "electron_logs"];
  for (const name of tools) assert.ok(requests.some(({ message }) => message.params.name === name),
    `host never invoked ${name}; model text cannot satisfy this assertion`);
  const dataFor = (name) => requests.filter(({ message }) => message.params.name === name)
    .map(({ message }) => responses.get(message.id)?.result?.structuredContent)
    .filter((result) => result?.ok).map((result) => result.data);
  for (const name of ["electron_attach", "electron_status"]) {
    assert.ok(dataFor(name).some((data) => data.main.online && data.renderer.online && data.selectedTarget),
      `${name} did not return two live sessions and a selected target`);
  }
  assert.ok(dataFor("electron_targets").some((data) => data.targets.length > 0 && data.selectedTarget));
  assert.ok(dataFor("electron_logs").some((data) => hasExpectedEvidence(data.events, "ipc")),
    "host did not receive both scoped IPC error messages");
  console.log(JSON.stringify({ host, version, tools, evidence: "both IPC channels", result: "PASS" }));
  succeeded = true;
} catch (error) {
  // Preserve test artifacts for diagnosing a host failure, without printing credential-bearing host logs.
  console.error(`Host smoke failed; local MCP trace directory: ${temporary}`);
  throw error;
} finally {
  if (hostProcess) await stopChild(hostProcess);
  if (fixture) await stopChild(fixture, () => fixture.send({ command: "quit" }));
  // Successful traces are disposable. Keep a failed trace only if present.
  if (succeeded) await rm(temporary, { recursive: true, force: true });
}
