import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { allTools } from "../src/tools/index.js";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

// The description shown on the OneTool platform is a separate text from SKILL.md and has gone stale before.
// These checks pin the facts that change with the code.
const description = read("docs/platform-description.md");
const detail = description.split("<!-- detail:start -->")[1]?.split("<!-- detail:end -->")[0] ?? "";
const brief = description.split("## 简要描述")[1]?.split("## 详细描述")[0]?.trim() ?? "";

test("the platform description keeps its brief and detail sections", () => {
  assert.ok(brief.length > 0 && brief.length <= 100, `brief description must be 1-100 characters, got ${brief.length}`);
  assert.ok(detail.startsWith("\n# Electron Agent Debug"), "detail must start with the skill title");
  for (const heading of ["## 功能简介", "## 适用场景", "## 不适用场景", "## 依赖要求", "## 使用方式"]) {
    assert.ok(detail.includes(heading), `detail is missing ${heading}`);
  }
  assert.equal(detail.includes("<<<"), false, "a placeholder was left in the description");
});

test("the platform description states the real tool count and Node.js version", () => {
  assert.ok(detail.includes(`${allTools.length} 个工具`),
    `the description must say ${allTools.length} 个工具 (the server registers ${allTools.length})`);
  assert.ok(read("skill/electron-debug/SKILL.md").includes(`${allTools.length} 个工具`),
    "SKILL.md must state the same tool count");
  const engines = (JSON.parse(read("package.json")) as { engines: { node: string } }).engines.node;
  const major = /(\d+)/u.exec(engines)?.[1];
  assert.ok(detail.includes(`Node.js ${major} 或更高版本`), `the description must require Node.js ${major}`);
});

test("the platform description mentions the behaviours an agent has to know about", () => {
  for (const term of ["sinceAttach", "droppedThroughSeq", "gap", "TARGET_CRASHED", "DevTools"]) {
    assert.ok(detail.includes(term), `the description should mention ${term}`);
  }
});
