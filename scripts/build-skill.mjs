import { build } from "esbuild";
import { builtinModules } from "node:module";
import { createHash } from "node:crypto";
import { readFile, readdir, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const check = process.argv.length === 3 && process.argv[2] === "--check";
if (process.argv.length !== 2 && !check) throw new Error("Usage: build-skill.mjs [--check]");
const skill = path.join(root, "skill/electron-debug");
const destination = path.join(skill, "runtime");
const pkg = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
const skillVersion = (await readFile(path.join(skill, "VERSION.md"), "utf8"))
  .match(/^## (\d+\.\d+\.\d+)\b/mu)?.[1];
if (!skillVersion) throw new Error("VERSION.md must identify the Skill release");
const builtins = new Set(builtinModules.flatMap((name) => [name, `node:${name}`]));
const result = await build({
  absWorkingDir: root,
  entryPoints: ["src/index.ts"],
  outfile: "server.cjs",
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  sourcemap: false,
  minifyWhitespace: true,
  legalComments: "inline",
  metafile: true,
  write: false,
  logLevel: "silent",
  plugins: [{
    name: "self-contained-runtime",
    setup(builder) {
      builder.onLoad({ filter: /[\\/]src[\\/]version\.ts$/ }, () => ({
        contents: `export const version = ${JSON.stringify(pkg.version)};`,
        loader: "js",
      }));
      // ws's optional native accelerators are unnecessary on supported Node versions.
      builder.onResolve({ filter: /^(bufferutil|utf-8-validate)$/ }, ({ path: name }) =>
        ({ path: name, namespace: "disabled-native" }));
      builder.onLoad({ filter: /.*/, namespace: "disabled-native" }, () =>
        ({ contents: 'throw new Error("Optional native accelerator is not included");', loader: "js" }));
    },
  }],
});
if (result.warnings.length) throw new Error(JSON.stringify(result.warnings));
for (const output of Object.values(result.metafile.outputs)) {
  for (const imported of output.imports) {
    if (imported.external && !builtins.has(imported.path)) {
      throw new Error(`Unbundled runtime dependency: ${imported.path}`);
    }
  }
}

// Preserve the licenses of every dependency whose code is present in the bundle.
const packages = new Map();
for (const input of Object.keys(result.metafile.inputs).sort()) {
  if (!input.startsWith("node_modules/")) continue;
  let directory = path.dirname(path.join(root, input));
  while (directory.startsWith(path.join(root, "node_modules"))) {
    try {
      const metadata = JSON.parse(await readFile(path.join(directory, "package.json"), "utf8"));
      if (metadata.name && metadata.version) {
        packages.set(`${metadata.name}@${metadata.version}`, { directory, metadata });
        break;
      }
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    directory = path.dirname(directory);
  }
}
const notices = [await readFile(path.join(root, "LICENSE"), "utf8")];
for (const [name, { directory, metadata }] of [...packages].sort(([a], [b]) => a.localeCompare(b, "en"))) {
  const licenses = (await readdir(directory)).filter((name) => /^(licen[cs]e|notice)([.-].*)?$/iu.test(name)).sort();
  if (!licenses.length) throw new Error(`Missing license text for bundled dependency: ${name}`);
  notices.push(`\n---\n${name} (${metadata.license ?? "see license text"})\n`);
  for (const license of licenses) notices.push(await readFile(path.join(directory, license), "utf8"));
}
async function sourceFiles(directory) {
  const files = [];
  for (const entry of await readdir(path.join(root, directory), { withFileTypes: true })) {
    const relative = `${directory}/${entry.name}`;
    if (entry.isDirectory()) files.push(...await sourceFiles(relative));
    else if (entry.isFile()) files.push(relative);
    else throw new Error(`Unexpected source entry: ${relative}`);
  }
  return files;
}
const sourceHash = createHash("sha256");
for (const filename of [...await sourceFiles("src"), ...await sourceFiles("scripts"),
  "package.json", "package-lock.json"].sort()) {
  const bytes = (await readFile(path.join(root, filename), "utf8")).replace(/\r\n/gu, "\n");
  sourceHash.update(`${filename}\0${Buffer.byteLength(bytes)}\0`).update(bytes);
}
const files = {
  "launch.cjs": Buffer.from((await readFile(path.join(root, "scripts/skill-launcher.cjs"), "utf8")).replace(/\r\n/gu, "\n")),
  "server.cjs": result.outputFiles[0].contents,
  "THIRD_PARTY_LICENSES.txt": Buffer.from(notices.join("\n").replace(/\r\n/gu, "\n")),
};
const manifest = {
  schemaVersion: 1, skillVersion, mcpVersion: pkg.version, entry: "server.cjs",
  sourceDigest: sourceHash.digest("hex"),
  files: Object.fromEntries(Object.entries(files).map(([name, bytes]) =>
    [name, createHash("sha256").update(bytes).digest("hex")])),
};
const artifacts = {
  ...files, "manifest.json": Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`),
};
if (!check) await mkdir(destination, { recursive: true });
for (const [filename, bytes] of Object.entries(artifacts)) {
  if (check) {
    if (!Buffer.from(bytes).equals(await readFile(path.join(destination, filename)))) {
      throw new Error(`Stale Skill runtime: ${filename}; run npm run build:skill`);
    }
  } else {
    await writeFile(path.join(destination, filename), bytes);
  }
}
console.log(JSON.stringify({
  skillVersion, mcpVersion: pkg.version, bundleBytes: files["server.cjs"].byteLength,
  bundledPackages: packages.size, sourceDigest: manifest.sourceDigest,
}));
