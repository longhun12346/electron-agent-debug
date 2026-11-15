import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const execFileAsync = promisify(execFile);

async function filesAt(directory: string, prefix = ""): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await readdir(path.join(directory, prefix), { withFileTypes: true })) {
    const relative = path.join(prefix, entry.name);
    assert.equal(entry.isSymbolicLink(), false, `package must be self-contained: ${relative}`);
    if (entry.isDirectory()) result.push(...await filesAt(directory, relative));
    else result.push(relative);
  }
  return result.sort();
}

async function validateReferences(directory: string): Promise<void> {
  assert.ok((await lstat(path.join(directory, "SKILL.md"))).isFile());
  for (const file of await filesAt(directory)) {
    if (!file.endsWith(".md")) continue;
    const contents = await readFile(path.join(directory, file), "utf8");
    // Includes inline and reference-style Markdown links, including linked images.
    const links = [
      ...[...contents.matchAll(/\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/gu)].map((match) => match[1]!),
      ...[...contents.matchAll(/^\s*\[[^\]]+\]:\s*(\S+)/gmu)].map((match) => match[1]!),
    ];
    for (const raw of links) {
      const href = raw.replace(/^<|>$/gu, "");
      if (/^https?:\/\//iu.test(href) || href.startsWith("#")) continue;
      const target = path.resolve(directory, path.dirname(file), decodeURIComponent(href.split("#")[0]!));
      const relative = path.relative(directory, target);
      assert.ok(relative && relative !== ".." && !relative.startsWith(`..${path.sep}`) &&
        !path.isAbsolute(relative), `reference escapes package: ${href}`);
      assert.ok((await lstat(target)).isFile(), `missing packaged reference: ${href}`);
    }
  }
}

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

test("archived Skill works in isolated project and global installation layouts", async (t) => {
  const temporary = await mkdtemp(path.join(tmpdir(), "electron skill package "));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const archive = path.join(temporary, "skill.tar");
  const source = path.join(root, "skill", "electron-debug");
  await execFileAsync("tar", ["-cf", archive, "-C", path.dirname(source), "electron-debug"]);
  const sourceFiles = await filesAt(source);
  assert.ok(sourceFiles.includes(path.join("references", "mcp-setup.md")));
  for (const layout of ["project/.agents/skills", "isolated-global/skills"]) {
    const destination = path.join(temporary, layout);
    await mkdir(destination, { recursive: true });
    await execFileAsync("tar", ["-xf", archive, "-C", destination]);
    const installed = path.join(destination, "electron-debug");
    assert.deepEqual(await filesAt(installed), sourceFiles);
    for (const file of sourceFiles) {
      assert.deepEqual(await readFile(path.join(installed, file)), await readFile(path.join(source, file)));
    }
    await validateReferences(installed);
    await rm(path.join(installed, "references", "mcp-setup.md"));
    await assert.rejects(validateReferences(installed), /ENOENT/u,
      "must detect a package that omitted its referenced setup guide");
    await writeFile(path.join(installed, "SKILL.md"), "[outside](../../outside.md)", "utf8");
    await assert.rejects(validateReferences(installed), /reference escapes package/u);
  }
});
