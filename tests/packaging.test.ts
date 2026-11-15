import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("keeps the repository package layout compatible with skills.sh", async () => {
  const skillsConfig = JSON.parse(
    await readFile(path.join(root, "skills.sh.json"), "utf8"),
  ) as { paths?: unknown };
  assert.deepEqual(skillsConfig.paths, ["./skill"]);

  const skillPath = path.join(root, "skill", "electron-debug", "SKILL.md");
  const skill = await readFile(skillPath, "utf8");
  const frontmatter = skill.match(/^---\r?\n([\s\S]*?)\r?\n---/u)?.[1] ?? "";

  assert.match(frontmatter, /^name:\s*electron-debug\s*$/mu);
  assert.match(frontmatter, /^description:\s*.+$/mu);
  assert.match(frontmatter, /^license:\s*MIT\s*$/mu);
});
