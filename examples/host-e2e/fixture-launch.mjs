import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { cp, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { freePort, discovery, waitUntil, stopChild } from "../fixture/test-support.mjs";

import { startField } from "../field-app/field-launch.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const fixtureRoot = path.join(root, "examples/fixture");
const run = promisify(execFile);

// Process ids whose command line contains the marker (a directory only this run uses), so cleanup can end exactly the
// processes a host started, by pid, and never anything else.
async function pidsWithMarker(marker) {
  try {
    if (process.platform === "win32") {
      const script = `Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -and $_.CommandLine.Contains('${marker.replaceAll("'", "''")}') } | ForEach-Object { $_.ProcessId }`;
      const { stdout } = await run("powershell", ["-NoProfile", "-Command", script], { timeout: 20_000 });
      return stdout.split(/\s+/u).filter(Boolean).map(Number);
    }
    const { stdout } = await run("pgrep", ["-f", marker], { timeout: 10_000 });
    return stdout.split(/\s+/u).filter(Boolean).map(Number);
  } catch {
    return [];
  }
}

async function endProcessesWithMarker(marker) {
  for (const pid of await pidsWithMarker(marker)) {
    try {
      if (process.platform === "win32") await run("taskkill", ["/PID", String(pid), "/T", "/F"], { timeout: 10_000 });
      else process.kill(pid, "SIGKILL");
    } catch { /* already gone */ }
  }
}

// The host starts the app itself. The runner only prepares a copy of the field app, starts it the way a developer's
// dev server would (no debug flags, so nothing can attach to it), and gives the host the command to start it again.
async function startAgentLaunched(scenario) {
  const electron = createRequire(path.join(fixtureRoot, "package.json"))("electron");
  const appDir = await mkdtemp(path.join(tmpdir(), "devapp-"));
  await cp(path.join(root, "examples/field-app"), appDir, { recursive: true });
  // The fault and the amount of console noise live in the app copy, not in the environment the host inherits.
  await writeFile(path.join(appDir, ".fault"), scenario.fixture.fault ?? "");
  const hostEnv = { FIELD_NOISE: "50" };
  const sandbox = process.env.FIXTURE_ELECTRON_NO_SANDBOX === "true" ? ["--no-sandbox"] : [];
  const running = spawn(electron, [...sandbox, appDir], { stdio: "ignore", env: { ...process.env, ...hostEnv } });
  await new Promise((resolve) => setTimeout(resolve, 2000));
  return {
    endpoints: {},
    hostEnv,
    launch: { appDir, command: `"${electron}" ${sandbox.map((flag) => `${flag} `).join("")}"${appDir}"` },
    // What the reference solution does by hand: start another instance with the debug flags and wait for both ports.
    async launchWithFlags() {
      const [mainPort, rendererPort] = [await freePort(), await freePort()];
      const child = spawn(electron, [...sandbox, `--inspect=${mainPort}`, `--remote-debugging-port=${rendererPort}`, appDir],
        { stdio: "ignore", env: { ...process.env, ...hostEnv } });
      child.unref();
      await Promise.all([
        waitUntil(() => discovery(mainPort), Array.isArray, "main discovery"),
        waitUntil(() => discovery(rendererPort), (targets) => Array.isArray(targets) && targets.length > 0, "renderer discovery", 20_000),
      ]);
      return { mainUrl: `http://127.0.0.1:${mainPort}`, rendererUrl: `http://127.0.0.1:${rendererPort}` };
    },
    async stop() {
      await stopChild(running);
      // Match on the unique directory name: a host may write the path in a short or forward-slash form.
      await endProcessesWithMarker(path.basename(appDir));
      await rm(appDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }).catch(() => {});
    },
  };
}

// Starts the app a scenario runs against on fresh loopback ports and waits until its debug endpoints answer. Most
// scenarios use the minimal fixture; `fixture.app: "field"` selects the field app that behaves like a development build,
// and `fixture.launch: "agent"` leaves starting it with debug flags to the host.
export async function startFixture(scenario, { stdio = ["ignore", "ignore", "ignore", "ipc"] } = {}) {
  if (scenario.fixture.launch === "agent") return startAgentLaunched(scenario);
  if (scenario.fixture.app === "field") {
    const field = await startField({ fault: scenario.fixture.fault ?? "", noise: scenario.fixture.noise ?? 800 });
    return { endpoints: field.endpoints, stop: field.stop };
  }
  const [mainPort, rendererPort] = [await freePort(), await freePort()];
  const electron = createRequire(path.join(fixtureRoot, "package.json"))("electron");
  const args = [`--inspect=${mainPort}`, `--remote-debugging-port=${rendererPort}`, fixtureRoot];
  if (process.env.FIXTURE_ELECTRON_NO_SANDBOX === "true") args.unshift("--no-sandbox");
  const env = { ...process.env, FIXTURE_RUN_ID: randomUUID(), FIXTURE_RENDERER_PORT: rendererPort };
  delete env.FIXTURE_FAULT;
  if (scenario.fixture.fault) env.FIXTURE_FAULT = scenario.fixture.fault;
  if (scenario.fixture.utility) {
    env.FIXTURE_UTILITY = "true";
    env.FIXTURE_UTILITY_PORT = await freePort();
  }
  const child = spawn(electron, args, { stdio, env });
  try {
    await Promise.all([
      waitUntil(() => discovery(mainPort), Array.isArray, "main discovery"),
      waitUntil(() => discovery(rendererPort), Array.isArray, "renderer discovery"),
    ]);
  } catch (error) {
    await stopChild(child);
    throw error;
  }
  return {
    endpoints: {
      ELECTRON_DEBUG_MAIN_URL: `http://127.0.0.1:${mainPort}`,
      ELECTRON_DEBUG_CDP_URL: `http://127.0.0.1:${rendererPort}`,
    },
    stop: () => stopChild(child, () => child.send({ command: "quit" })),
  };
}
