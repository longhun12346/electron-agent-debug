import { cp, mkdtemp, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const temporary = await mkdtemp(path.join(tmpdir(), "electron installed package "));
try {
  const installed = path.join(temporary, "electron-debug");
  await cp(path.join(root, "skill/electron-debug"), installed, { recursive: true });
  const child = spawn(process.execPath, [path.join(root, "examples/fixture/ci-smoke.mjs")], {
    stdio: "inherit",
    env: { ...process.env, ELECTRON_DEBUG_TEST_MCP_ENTRY: path.join(installed, "runtime/launch.cjs") },
  });
  await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => code === 0 ? resolve()
      : reject(new Error(`installed Skill fixture smoke failed: ${code ?? signal}`)));
  });
} finally {
  await rm(temporary, { recursive: true, force: true });
}
