import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

// The two texts a publishing platform shows, taken from docs/platform-description.md and written as UTF-8 bytes.
//
//   node scripts/platform-text.mjs brief      the brief description
//   node scripts/platform-text.mjs detail     the detailed description
//   <platform's JSON> | node scripts/platform-text.mjs --verify
//                                              compares what the platform returns with the file; exit code 1 on a difference
//
// Node writes UTF-8 to a pipe on every system. A Python `print()` on Windows writes the console code page instead, which
// is how GBK bytes were once published as the description and shown as mojibake. After publishing, pipe the platform's
// own record back through --verify: an echo that looks right in a terminal proves nothing about what was stored.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = (await readFile(path.join(root, "docs/platform-description.md"), "utf8")).replace(/\r\n/gu, "\n");
const texts = {
  brief: source.split("## 简要描述")[1]?.split("## 详细描述")[0]?.trim(),
  detail: source.split("<!-- detail:start -->")[1]?.split("<!-- detail:end -->")[0]?.trim(),
};
for (const [name, text] of Object.entries(texts)) {
  if (!text) throw new Error(`docs/platform-description.md has no ${name} description`);
}

const normalize = (text) => String(text ?? "").replace(/\r\n/gu, "\n").trim();

// The first place two texts differ, with a little of each around it.
function difference(expected, actual) {
  let index = 0;
  while (index < expected.length && expected[index] === actual[index]) index += 1;
  const around = (text) => JSON.stringify(text.slice(Math.max(0, index - 20), index + 40));
  return `first difference at character ${index}: file has ${around(expected)}, platform has ${around(actual)}`;
}

// Finds a string field by name anywhere in the platform's answer, so the exact nesting does not matter.
function field(value, name) {
  if (typeof value !== "object" || value === null) return undefined;
  if (typeof value[name] === "string") return value[name];
  for (const child of Object.values(value)) {
    const found = field(child, name);
    if (found !== undefined) return found;
  }
  return undefined;
}

const [mode, ...rest] = process.argv.slice(2);
if (rest.length === 0 && (mode === "brief" || mode === "detail")) {
  process.stdout.write(`${texts[mode]}\n`);
} else if (rest.length === 0 && mode === "--verify") {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const record = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  const problems = [];
  for (const [name, key] of [["brief", "briefDesc"], ["detail", "detailDoc"]]) {
    const published = field(record, key);
    if (published === undefined) problems.push(`${name}: the platform's answer has no ${key}`);
    else if (normalize(published) !== texts[name]) problems.push(`${name}: ${difference(texts[name], normalize(published))}`);
  }
  process.stdout.write(`${JSON.stringify({ ok: problems.length === 0, problems })}\n`);
  process.exitCode = problems.length === 0 ? 0 : 1;
} else {
  process.stderr.write("usage: platform-text.mjs <brief | detail | --verify>\n");
  process.exitCode = 2;
}
