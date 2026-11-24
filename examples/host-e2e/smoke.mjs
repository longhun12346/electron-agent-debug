import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { stopChild } from "../fixture/test-support.mjs";
import { startFixture } from "./fixture-launch.mjs";
import { allTools, callsFromTraffic, scenarioNames, scenarios } from "./scenarios.mjs";

const usage = `usage: node examples/host-e2e/smoke.mjs <codex|claude> [absolute-host-executable] [--scenario <${scenarioNames.join("|")}|all>] [--no-skill]`;
const argv = process.argv.slice(2);
const noSkillAt = argv.indexOf("--no-skill");
const withoutSkill = noSkillAt !== -1;
if (withoutSkill) argv.splice(noSkillAt, 1);
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
    if (scenario.shell && host !== "claude") throw new Error(`${name} lets the host use a shell and is only wired for claude`);
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
    // Shell scenarios name the dev command and the project directory the runner prepared.
    const task = scenario.prompt.replaceAll("{{command}}", fixture.launch?.command ?? "").replaceAll("{{appDir}}", fixture.launch?.appDir ?? "");
    const prompt = withoutSkill ? task
      : `${task}\nThe following is the installed Skill supplied explicitly for this test:\n\n${skill}`;
    let args;
    if (host === "claude") {
      const config = path.join(temporary, "mcp-config.json");
      await writeFile(config, JSON.stringify({ mcpServers: { "electron-debug": server } }));
      // A shell scenario gets Bash behind a guard hook that refuses stopping processes and deleting or rewriting files.
      // The hook lives in the run's own project settings: --settings would replace the login the host needs here.
      if (scenario.shell) await mkdir(path.join(temporary, ".claude"), { recursive: true });
      if (scenario.shell) await writeFile(path.join(temporary, ".claude/settings.json"), JSON.stringify({ hooks: { PreToolUse: [{ matcher: "Bash", hooks: [
        { type: "command", command: `"${process.execPath}" "${path.join(root, "examples/host-e2e/shell-guard.mjs")}"` }] }] } }));
      args = ["--print", "--strict-mcp-config", "--mcp-config", config,
        "--setting-sources", scenario.shell ? "project" : "", "--no-session-persistence", "--tools", scenario.shell ? "Bash" : "",
        "--allowedTools", [...allTools.map((tool) => `mcp__electron-debug__${tool}`), ...(scenario.shell ? ["Bash"] : [])].join(","),
        "--output-format", "stream-json", "--verbose", prompt];
    } else {
      // Pre-authorize only this test server's tools for the noninteractive run.
      // This command-line override does not change the user's saved MCP policy.
      const toml = `{electron-debug={command=${JSON.stringify(server.command)},args=${JSON.stringify(server.args)},default_tools_approval_mode="approve",env={${Object.entries(server.env).map(([key, value]) => `${key}=${JSON.stringify(value)}`).join(",")}}}}`;
      args = ["exec", "--ephemeral", "--skip-git-repo-check", "--json", "-C", temporary,
        "-c", `mcp_servers=${toml}`, "-c", 'approval_policy="never"', "-s", "read-only", prompt];
    }
    hostProcess = spawn(executable, args, {
      cwd: temporary, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, ...(fixture.hostEnv ?? {}) },
    });
    let output = "";
    let stderr = "";
    hostProcess.stdout.on("data", (chunk) => { output = (output + chunk).slice(-200_000); });
    hostProcess.stderr.on("data", (chunk) => { stderr = (stderr + chunk).slice(-20_000); });
    const limit = scenario.shell ? 300 : 180;
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`host integration timed out after ${limit}s`)), limit * 1000);
      hostProcess.once("error", (error) => { clearTimeout(timer); reject(error); });
      // A host that started the app in the background keeps running after it has answered, so a shell scenario ends
      // when the host's result event arrives instead of when the process exits.
      const poll = scenario.shell ? setInterval(() => {
        const result = output.split("\n").findLast((line) => line.includes('"type":"result"'));
        if (!result) return;
        clearInterval(poll);
        clearTimeout(timer);
        if (result.includes('"is_error":true')) reject(new Error(`${host} reported an error result`));
        else resolve();
      }, 500) : undefined;
      hostProcess.once("exit", (code) => {
        clearTimeout(timer);
        clearInterval(poll);
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
    // Informational only: the verdict the host reported. Passing is judged on the MCP traffic, never on this text.
    const finalText = output.split(/\r?\n/u).map((line) => { try { return JSON.parse(line); } catch { return undefined; } })
      .findLast((message) => message?.type === "result")?.result ?? "";
    const verdict = /\b(PASS|FAIL|BLOCKED)\b/u.exec(String(finalText))?.[1];
    const expected = scenario.expectedVerdict;
    console.log(JSON.stringify({ host, version, scenario: name, verdict, ...(expected ? { expected, verdictCorrect: verdict === expected } : {}), tools: [...new Set(calls.map((call) => call.name))], skill: !withoutSkill, result: "PASS" }));
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
