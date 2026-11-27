import assert from "node:assert/strict";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function filesUnder(directory: string, extension: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "runtime") continue;
      found.push(...await filesUnder(full, extension));
    } else if (entry.name.endsWith(extension)) {
      found.push(full);
    }
  }
  return found;
}

const sourceText = async () =>
  (await Promise.all((await filesUnder(path.join(root, "src"), ".ts")).map((file) => readFile(file, "utf8")))).join("\n");

// The Skill and its references are what an agent follows, so every tool, setting and error name in them must exist.
const skillFiles = async () => [
  path.join(root, "skill/electron-debug/SKILL.md"),
  ...(await filesUnder(path.join(root, "skill/electron-debug/references"), ".md")),
];

// Names the docs use that belong to other programs, not to this server.
const external = new Set([
  "ELECTRON_RUN_AS_NODE", "ELECTRON_EXTRA_LAUNCH_ARGS", "V8_INSPECTOR_PORT", "REMOTE_DEBUGGING_PORT",
]);

test("every tool, environment variable and error code the Skill names exists in the source", async () => {
  const source = await sourceText();
  const missing: string[] = [];
  for (const file of await skillFiles()) {
    const text = await readFile(file, "utf8");
    for (const match of text.matchAll(/`(electron_[a-z_]+)`/gu)) {
      if (!source.includes(`"${match[1]}"`)) missing.push(`${path.basename(file)}: tool ${match[1]}`);
    }
    for (const match of text.matchAll(/\b(ELECTRON_DEBUG_[A-Z_]+)\b/gu)) {
      if (!external.has(match[1]!) && !source.includes(match[1]!)) missing.push(`${path.basename(file)}: variable ${match[1]}`);
    }
    for (const match of text.matchAll(/`([A-Z]{2,}(?:_[A-Z0-9]+)+)`/gu)) {
      const name = match[1]!;
      if (external.has(name) || name.startsWith("ELECTRON_DEBUG_") || name.startsWith("ELECTRON_")) continue;
      if (!source.includes(`"${name}"`)) missing.push(`${path.basename(file)}: code ${name}`);
    }
  }
  assert.deepEqual([...new Set(missing)], []);
});

test("relative links in the Skill, the README and the docs point at files that exist", async () => {
  const files = [
    ...await skillFiles(),
    path.join(root, "README.md"),
    path.join(root, "CONTRIBUTING.md"),
    ...await filesUnder(path.join(root, "docs"), ".md"),
  ];
  const broken: string[] = [];
  for (const file of files) {
    const text = await readFile(file, "utf8");
    for (const match of text.matchAll(/\]\((?!https?:|#|mailto:)([^)\s]+)\)/gu)) {
      const target = path.resolve(path.dirname(file), decodeURIComponent(match[1]!.split("#")[0]!));
      try {
        await stat(target);
      } catch {
        broken.push(`${path.relative(root, file)} -> ${match[1]}`);
      }
    }
  }
  assert.deepEqual(broken, []);
});
