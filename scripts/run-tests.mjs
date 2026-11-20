import { spawn } from "node:child_process";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

// `tsx --test tests/*.test.ts` relies on the shell or on Node 21+ to expand the glob. Windows shells do not expand it
// and Node 20 does not either, so list the files here and run the same command on every platform.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const files = (await readdir(path.join(root, "tests")))
  .filter((name) => name.endsWith(".test.ts"))
  .sort()
  .map((name) => path.join("tests", name));

const child = spawn(
  process.execPath,
  [path.join(root, "node_modules", "tsx", "dist", "cli.mjs"), "--test", ...files],
  { cwd: root, stdio: "inherit" },
);
child.once("error", (error) => {
  console.error(error);
  process.exit(1);
});
child.once("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
