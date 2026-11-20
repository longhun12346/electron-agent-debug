import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { stopChild } from "../fixture/test-support.mjs";
import { startFixture } from "./fixture-launch.mjs";
import { allTools, callsFromTraffic, scenarioNames, scenarios } from "./scenarios.mjs";

const usage = `usage: node examples/host-e2e/smoke.mjs <codex|claude> [absolute-host-executable] [--scenario <${scenarioNames.join("|")}|all>]`;
const argv = process.argv.slice(2);
const flag = argv.indexOf("--scenario");
const requested = flag === -1 ? "ipc" : argv[flag + 1];
if (flag !== -1) argv.splice(flag, 2);
const [host, executable = host] = argv;
if (!["codex", "claude"].includes(host)) throw new Error(usage);
const names = requested === "all" ? scenarioNames : [requested];
for (const name of names) assert.ok(scenarios[name], `unknown scenario: ${requested}\n${usage}`);

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const skill = await readFile(path.join(root, "skill/electron-debug/SKILL.md"), "utf8");
const version = (await promisify(execFile)(executable, ["--version"], { timeout: 10_000 })).stdout.trim();

// On Windows the MCP relay or Electron can still hold a handle on the trace directory for a moment after the host
// exits, which makes the first rmdir fail with EBUSY. Retry, and never let leftover temp files turn a passing scenario
// into a failing run: say where they are instead.
async function removeTemporary(directory) {
  try {
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  } catch (error) {
    console.warn(`Scenario passed, but the temporary directory could not be removed (${error.code ?? error.message}): ${directory}`);
  }
}

async function runScenario(name) {
  const scenario = scenarios[name];
  const temporary = await mkdtemp(path.join(tmpdir(), "electron host smoke "));
  const trace = path.join(temporary, "mcp.jsonl");
  let fixture;
  let hostProcess;
  let succeeded = false;
  try {
    fixture = await startFixture(scenario);
    const server = {
      command: process.execPath,
      args: [path.join(root, "examples/host-e2e/mcp-trace.mjs"), root, trace],
      env: {
        ...fixture.endpoints,
        ...(process.env.ELECTRON_DEBUG_TEST_MCP_ENTRY ? {
          ELECTRON_DEBUG_TEST_MCP_ENTRY: path.resolve(process.env.ELECTRON_DEBUG_TEST_MCP_ENTRY),
        } : {}),
      },
    };
    const prompt = `${scenario.prompt}\nThe following is the installed Skill supplied explicitly for this test:\n\n${skill}`;
    let args;
    if (host === "claude") {
      const config = path.join(temporary, "mcp-config.json");
      await writeFile(config, JSON.stringify({ mcpServers: { "electron-debug": server } }));
      args = ["--print", "--strict-mcp-config", "--mcp-config", config,
        "--setting-sources", "", "--no-session-persistence", "--tools", "",
        "--allowedTools", allTools.map((tool) => `mcp__electron-debug__${tool}`).join(","),
        "--output-format", "stream-json", "--verbose", prompt];
    } else {
      // Pre-authorize only this test server's tools for the noninteractive run.
      // This command-line override does not change the user's saved MCP policy.
      const toml = `{electron-debug={command=${JSON.stringify(server.command)},args=${JSON.stringify(server.args)},default_tools_approval_mode="approve",env={${Object.entries(server.env).map(([key, value]) => `${key}=${JSON.stringify(value)}`).join(",")}}}}`;
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
      const timer = setTimeout(() => reject(new Error("host integration timed out after 180s")), 180_000);
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
    const calls = callsFromTraffic(traffic);
    scenario.verify(calls);
    console.log(JSON.stringify({ host, version, scenario: name, tools: [...new Set(calls.map((call) => call.name))], result: "PASS" }));
    succeeded = true;
  } catch (error) {
    // Preserve test artifacts for diagnosing a host failure, without printing credential-bearing host logs.
    console.error(`Host smoke failed (${name}); local MCP trace directory: ${temporary}`);
    throw error;
  } finally {
    if (hostProcess) await stopChild(hostProcess);
    if (fixture) await fixture.stop();
    // Successful traces are disposable. Keep a failed trace only if present.
    if (succeeded) await removeTemporary(temporary);
  }
}

for (const name of names) await runScenario(name);
