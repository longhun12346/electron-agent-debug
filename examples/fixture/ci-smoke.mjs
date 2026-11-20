import { spawn } from "node:child_process";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const fixtureRoot = path.dirname(fileURLToPath(import.meta.url));
const smokeScript = path.join(fixtureRoot, "mcp-smoke.mjs");

function findFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("could not determine the dynamically allocated port"));
        return;
      }
      server.close(() => resolve(String(address.port)));
    });
  });
}

async function runSmoke(fault) {
  const [mainPort, rendererPort] = await Promise.all([findFreePort(), findFreePort()]);
  return new Promise((resolve, reject) => {
    const env = {
      ...process.env,
      FIXTURE_MAIN_PORT: mainPort,
      FIXTURE_RENDERER_PORT: rendererPort,
    };
    if (fault) {
      env.FIXTURE_FAULT = fault;
    } else {
      delete env.FIXTURE_FAULT;
    }

    console.log(`Running fixture smoke: ${fault || "default"} (${mainPort}, ${rendererPort})`);
    const child = spawn(process.execPath, [smokeScript], {
      stdio: "inherit",
      env,
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`fixture smoke failed for ${fault || "default"}: ${code ?? signal}`));
    });
  });
}

for (const fault of ["", "main-window", "renderer", "ipc"]) {
  await runSmoke(fault);
}

console.log("Running fixture smoke: blocked");
const blocked = spawn(process.execPath, [path.join(fixtureRoot, "blocked-smoke.mjs")], {
  stdio: "inherit",
  env: process.env,
});
await new Promise((resolve, reject) => {
  blocked.once("error", reject);
  blocked.once("exit", (code, signal) => {
    if (code === 0) {
      resolve();
      return;
    }
    reject(new Error(`fixture blocked smoke failed: ${code ?? signal}`));
  });
});

async function runScript(name, label) {
  console.log(`Running fixture smoke: ${label}`);
  const child = spawn(process.execPath, [path.join(fixtureRoot, name)], { stdio: "inherit", env: process.env });
  await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => code === 0
      ? resolve()
      : reject(new Error(`fixture ${label} smoke failed: ${code ?? signal}`)));
  });
}

await runScript("utility-smoke.mjs", "utility process attach");
await runScript("inspection-smoke.mjs", "evaluate, wait_for, screenshot, snapshot and stack rendering");
await runScript("../host-e2e/reference.mjs", "host-e2e scenarios solved by their scripted reference runs");
await runScript("../field-app/field-smoke.mjs", "field app: ESM main, two windows, DevTools, noise, large page, crash and exit");

console.log("Running fixture smoke: reload, window recreation and Electron restart");
const lifecycle = spawn(process.execPath, [path.join(fixtureRoot, "lifecycle-smoke.mjs")], {
  stdio: "inherit", env: process.env,
});
await new Promise((resolve, reject) => {
  lifecycle.once("error", reject);
  lifecycle.once("exit", (code, signal) => code === 0
    ? resolve()
    : reject(new Error(`fixture lifecycle smoke failed: ${code ?? signal}`)));
});
