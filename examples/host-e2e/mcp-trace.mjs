// Test-only transparent stdio relay. Trace files contain MCP traffic, never host API credentials.
import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";
import path from "node:path";

const [root, trace] = process.argv.slice(2);
if (!root || !trace) throw new Error("expected repository root and trace path");
const child = spawn(process.execPath, [path.join(root, "dist/index.js")], {
  stdio: ["pipe", "pipe", "inherit"], env: process.env,
});

function forward(source, destination, direction) {
  let buffer = "";
  source.on("data", (chunk) => {
    destination.write(chunk);
    buffer += chunk.toString();
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (line.trim()) appendFileSync(trace, `${JSON.stringify({ direction, message: JSON.parse(line) })}\n`);
    }
  });
}
forward(process.stdin, child.stdin, "request");
forward(child.stdout, process.stdout, "response");
process.stdin.on("end", () => child.stdin.end());
child.stdin.on("error", () => {});
child.on("error", (error) => {
  console.error(error.message);
  process.stdin.destroy();
  process.exitCode = 1;
});
child.on("exit", (code) => {
  process.stdin.destroy();
  process.exitCode = code ?? 1;
});
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => child.stdin.end());
}
