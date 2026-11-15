import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const execFileAsync = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("external harness builds absent and stale MCP output in a path containing spaces",
  { timeout: 30_000 }, async (t) => {
    const temporary = await mkdtemp(path.join(os.tmpdir(), "electron debug build "));
    t.after(async () => {
      assert.equal(path.dirname(path.resolve(temporary)), path.resolve(os.tmpdir()));
      assert.ok(path.basename(temporary).startsWith("electron debug build "));
      await rm(temporary, { recursive: true, force: true });
    });
    const harness = path.join(temporary, "examples", "external-e2e", "electron-vite-react-smoke.mjs");
    await mkdir(path.dirname(harness), { recursive: true });
    await cp(path.join(root, "examples/external-e2e/electron-vite-react-smoke.mjs"), harness);
    await symlink(path.join(root, "node_modules"), path.join(temporary, "node_modules"),
      process.platform === "win32" ? "junction" : "dir");
    await mkdir(path.join(temporary, "src"));
    await writeFile(path.join(temporary, "package.json"), JSON.stringify({
      type: "module", scripts: { build: "tsc -p tsconfig.json" },
    }));
    await writeFile(path.join(temporary, "tsconfig.json"), JSON.stringify({
      compilerOptions: { outDir: "dist", rootDir: "src", types: [], skipLibCheck: true },
      include: ["src/**/*.ts"],
    }));

    const env: NodeJS.ProcessEnv = { ...process.env, ELECTRON_E2E_PROJECT_ROOT: temporary };
    delete env.ELECTRON_E2E_ELECTRON;
    for (const marker of ["initial", "updated"]) {
      await writeFile(path.join(temporary, "src/index.ts"), `export const marker = "${marker}";\n`);
      const result = await execFileAsync(process.execPath, [harness], {
        cwd: temporary, env, timeout: 10_000,
      }).then(
        (value) => ({ ...value, failed: false }),
        (error: { stdout: string; stderr: string }) => ({ ...error, failed: true }),
      );
      // Stop after building, before starting an external Electron application.
      assert.equal(result.failed, true);
      assert.match(result.stderr, /请提供 ELECTRON_E2E_ELECTRON/u);
      assert.match(await readFile(path.join(temporary, "dist/index.js"), "utf8"),
        new RegExp(`"${marker}"`, "u"));
    }
  });
