import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const electron = require("electron");
const root = path.dirname(fileURLToPath(import.meta.url));
const mainPort = process.env.FIXTURE_MAIN_PORT;
const rendererPort = process.env.FIXTURE_RENDERER_PORT;

if (!mainPort || !rendererPort) {
  throw new Error("请提供 FIXTURE_MAIN_PORT 和 FIXTURE_RENDERER_PORT，端口由 Agent 或测试脚本决定");
}

const child = spawn(
  electron,
  [`--inspect=${mainPort}`, `--remote-debugging-port=${rendererPort}`, root],
  {
    stdio: "inherit",
    env: process.env,
  },
);

async function waitForDiscovery(port, label) {
  const url = `http://127.0.0.1:${port}/json/list`;
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        console.log(`${label}: ${await response.text()}`);
        return;
      }
    } catch {
      // The application may still be starting.
    }
    await delay(100);
  }
  throw new Error(`${label} discovery timeout`);
}

try {
  await Promise.all([
    waitForDiscovery(mainPort, "main"),
    waitForDiscovery(rendererPort, "renderer"),
  ]);
} finally {
  child.kill();
}
