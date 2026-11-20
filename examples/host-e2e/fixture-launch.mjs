import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { freePort, discovery, waitUntil, stopChild } from "../fixture/test-support.mjs";

import { startField } from "../field-app/field-launch.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const fixtureRoot = path.join(root, "examples/fixture");

// Starts the app a scenario runs against on fresh loopback ports and waits until its debug endpoints answer. Most
// scenarios use the minimal fixture; `fixture.app: "field"` selects the field app that behaves like a development build.
export async function startFixture(scenario, { stdio = ["ignore", "ignore", "ignore", "ipc"] } = {}) {
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
