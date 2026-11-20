import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { discovery, freePort, stopChild, waitUntil } from "../fixture/test-support.mjs";

const fieldRoot = path.dirname(fileURLToPath(import.meta.url));
const fixtureRoot = path.join(fieldRoot, "../fixture");

// Starts the field app on fresh loopback ports and waits until both of its windows and DevTools are listed.
// The Electron binary comes from the minimal fixture's dependencies.
export async function startField({ fault = "", noise = 800, devtools = true } = {}) {
  const [mainPort, rendererPort] = [await freePort(), await freePort()];
  const electron = createRequire(path.join(fixtureRoot, "package.json"))("electron");
  const args = [`--inspect=${mainPort}`, `--remote-debugging-port=${rendererPort}`, fieldRoot];
  if (process.env.FIXTURE_ELECTRON_NO_SANDBOX === "true") args.unshift("--no-sandbox");
  const run = randomUUID();
  const env = {
    ...process.env,
    FIELD_RUN_ID: run,
    FIELD_FAULT: fault,
    FIELD_NOISE: String(noise),
    FIELD_DEVTOOLS: String(devtools),
    FIELD_RENDERER_PORT: rendererPort,
  };
  const child = spawn(electron, args, { stdio: ["ignore", "inherit", "inherit", "ipc"], env });
  const exited = new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
  let commandId = 0;
  const pending = new Map();
  child.on("message", (message) => pending.get(message.id)?.(message));
  try {
    await waitUntil(() => discovery(mainPort), Array.isArray, "main discovery");
    await waitUntil(() => discovery(rendererPort),
      (targets) => ["Field App", "Field Settings"].every((title) => targets?.some((target) => target.title === title))
        && (!devtools || targets.some((target) => target.url.startsWith("devtools://"))),
      "field windows", 20_000);
  } catch (error) {
    await stopChild(child);
    throw error;
  }
  return {
    run,
    mainPort,
    rendererPort,
    endpoints: {
      ELECTRON_DEBUG_MAIN_URL: `http://127.0.0.1:${mainPort}`,
      ELECTRON_DEBUG_CDP_URL: `http://127.0.0.1:${rendererPort}`,
    },
    exited,
    // Runs a runner-only command inside the app and resolves with its acknowledgement.
    command(name, timeoutMs = 10_000) {
      const id = ++commandId;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`field command timed out: ${name}`)), timeoutMs);
        pending.set(id, (message) => { clearTimeout(timer); pending.delete(id); resolve(message); });
        child.send({ id, command: name });
      });
    },
    stop: () => stopChild(child, () => child.send({ command: "quit" })),
  };
}
