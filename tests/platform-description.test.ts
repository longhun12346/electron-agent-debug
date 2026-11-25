import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";
import { allTools } from "../src/tools/index.js";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

// The description shown on the OneTool platform is a separate text from SKILL.md and has gone stale before.
// This pins the facts that change with the code; whether conditions are stated in full and risks are prominent is
// checked by hand against the list in CONTRIBUTING.md.
const description = read("docs/platform-description.md");
const detail = description.split("<!-- detail:start -->")[1]?.split("<!-- detail:end -->")[0] ?? "";
const brief = description.split("## 简要描述")[1]?.split("## 详细描述")[0]?.trim() ?? "";

test("the platform description fits its limits and states the real tool count and Node.js version", () => {
  assert.ok(brief.length > 0 && [...brief].length <= 100, `brief description must be 1-100 characters, got ${[...brief].length}`);
  assert.ok(detail.includes(`${allTools.length} 个工具`),
    `the description must say ${allTools.length} 个工具 (the server registers ${allTools.length})`);
  assert.ok(read("skill/electron-debug/SKILL.md").includes(`${allTools.length} 个工具`),
    "SKILL.md must state the same tool count");
  const engines = (JSON.parse(read("package.json")) as { engines: { node: string } }).engines.node;
  const major = /(\d+)/u.exec(engines)?.[1];
  assert.ok(detail.includes(`Node.js ${major} 或更高版本`), `the description must require Node.js ${major}`);
  const manifest = JSON.parse(read("skill/electron-debug/runtime/manifest.json")) as { skillVersion: string; mcpVersion: string };
  assert.ok(detail.includes(`Skill ${manifest.skillVersion}（MCP ${manifest.mcpVersion}）`),
    `the description must name Skill ${manifest.skillVersion} and MCP ${manifest.mcpVersion}`);
});

function sourceFiles(directory: string): string[] {
  return readdirSync(new URL(`../${directory}`, import.meta.url), { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? sourceFiles(`${directory}/${entry.name}`) : entry.name.endsWith(".ts") ? [`${directory}/${entry.name}`] : []);
}

test("every setting, error code, parameter and tool the platform description names exists in the source", () => {
  const source = sourceFiles("src").map(read).join("\n");
  // Names that belong to Electron, Node or the app under test rather than to this server.
  const foreign = new Set(["ELECTRON_RUN_AS_NODE", "contextBridge", "utilityProcess", "mainModule", "mcpServers"]);
  const names = new Set<string>();
  for (const match of detail.matchAll(/\b(ELECTRON_[A-Z_]+|[A-Z]{3,}(?:_[A-Z]+)+)\b/gu)) names.add(match[1]!);
  for (const match of detail.matchAll(/\b([a-z]+[A-Z][A-Za-z]*)\b/gu)) names.add(match[1]!);
  for (const match of detail.matchAll(/\b(electron_[a-z_]+)\b/gu)) names.add(match[1]!);
  assert.ok(names.size > 8, "the check found too few names to mean anything");
  const missing = [...names].filter((name) => !foreign.has(name) && !source.includes(name));
  assert.deepEqual(missing, [], "the description names things that are not in the source");
});
