import { cp, mkdtemp, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Runs the smoke scenarios against a copy of the Skill in a folder with spaces in its name, through the MCP that ships in
// it (runtime/launch.cjs), not the source build. This is what catches packaging mistakes. Arguments select scenarios.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const temporary = await mkdtemp(path.join(tmpdir(), "electron installed package "));
try {
  const installed = path.join(temporary, "electron-debug");
  await cp(path.join(root, "skill/electron-debug"), installed, { recursive: true });
  const child = spawn(process.execPath, [path.join(root, "examples/vue-vite-app/smoke.mjs"), ...process.argv.slice(2)], {
    stdio: "inherit",
    env: { ...process.env, ELECTRON_DEBUG_TEST_MCP_ENTRY: path.join(installed, "runtime/launch.cjs") },
  });
  await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => code === 0 ? resolve()
      : reject(new Error(`installed Skill smoke failed: ${code ?? signal}`)));
  });
} finally {
  await rm(temporary, { recursive: true, force: true });
}
