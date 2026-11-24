import { spawn } from "node:child_process";
import { access, cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Measures how often a real Claude Code host invokes the electron-debug Skill for realistic requests, with the Skill
// description as the only thing that can make it do so. Each request runs `claude -p` in a throwaway Electron project
// whose only project skill is a copy of skill/electron-debug. The host gets read-only tools, and the run stops as soon as
// the decision is visible, so a run costs a fraction of a real task. See README.md.
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const usage = `usage: node examples/trigger-eval/run.mjs [options]
  --claude <exe>       Claude Code executable (default: claude)
  --variant <name>     current (SKILL.md as it is), off (no skill installed, the baseline), or the name of a file in
                       descriptions/ (without .txt) or a path to a .txt file holding one description (default: current)
  --install <where>    project (a copy in the throwaway project's .claude/skills, default) or user (a temporary copy in
                       ~/.claude/skills, loaded with your user settings and the skills you already have; it is removed
                       afterwards, and the run refuses to start if ~/.claude/skills/electron-debug already exists)
  --reps <n>           runs per request (default 3)
  --parallel <n>       runs at the same time (default 3)
  --split <name>       all, train or validation (default all)
  --only <ids>         comma separated request ids
  --window <n>         the Skill must be called within the first n tool calls (default 4)
  --budget <usd>       cost cap per run (default 0.5)
  --no-early-stop      let every run finish, to measure its real cost
  --model <name>       model to use
  --out <file>         write the full results as JSON
  --keep               keep the temporary project`;

const options = {
  claude: "claude", variant: "current", install: "project", reps: 3, parallel: 3, split: "all", window: 4, budget: 0.5,
  earlyStop: true, queries: path.join(here, "queries.json"),
};
const argv = process.argv.slice(2);
for (let index = 0; index < argv.length; index += 1) {
  const flag = argv[index];
  const value = () => {
    if (index + 1 >= argv.length) throw new Error(`${flag} needs a value\n${usage}`);
    return argv[++index];
  };
  if (flag === "--claude") options.claude = value();
  else if (flag === "--variant") options.variant = value();
  else if (flag === "--install") {
    options.install = value();
    if (!["project", "user"].includes(options.install)) throw new Error(`--install is project or user\n${usage}`);
  } else if (flag === "--reps") options.reps = Number(value());
  else if (flag === "--parallel") options.parallel = Number(value());
  else if (flag === "--split") options.split = value();
  else if (flag === "--only") options.only = value().split(",");
  else if (flag === "--window") options.window = Number(value());
  else if (flag === "--budget") options.budget = Number(value());
  else if (flag === "--no-early-stop") options.earlyStop = false;
  else if (flag === "--model") options.model = value();
  else if (flag === "--out") options.out = value();
  else if (flag === "--keep") options.keep = true;
  else throw new Error(`unknown option ${flag}\n${usage}`);
}

let queries = JSON.parse(await readFile(options.queries, "utf8"));
if (options.split !== "all") queries = queries.filter((query) => query.split === options.split);
if (options.only) queries = queries.filter((query) => options.only.includes(query.id));
if (queries.length === 0) throw new Error("no requests selected");

async function resolveDescription() {
  if (options.variant === "current" || options.variant === "off") return undefined;
  const file = options.variant.endsWith(".txt") ? options.variant : path.join(here, "descriptions", `${options.variant}.txt`);
  return (await readFile(file, "utf8")).trim();
}

// A copy of the field app stands in for the user's project: it looks like an Electron project and has no skills of its own.
async function prepareProject(description) {
  const workspace = await mkdtemp(path.join(tmpdir(), "trigger eval "));
  const app = path.join(workspace, "app");
  await cp(path.join(root, "examples/field-app"), app, { recursive: true });
  let installed;
  if (options.variant !== "off") {
    const user = options.install === "user";
    const target = user ? path.join(homedir(), ".claude/skills/electron-debug") : path.join(app, ".claude/skills/electron-debug");
    if (user) {
      // Never overwrite or delete something the user put there: refuse, and only remove what this run created.
      if (await access(target).then(() => true, () => false)) {
        throw new Error(`${target} already exists; remove it first or use --install project`);
      }
      installed = target;
    }
    try {
      await cp(path.join(root, "skill/electron-debug"), target, { recursive: true });
      if (description !== undefined) {
        const file = path.join(target, "SKILL.md");
        const text = await readFile(file, "utf8");
        const next = text.replace(/^description:.*$/mu, () => `description: ${JSON.stringify(description)}`);
        if (next === text) throw new Error("could not replace the description in SKILL.md");
        await writeFile(file, next);
      }
    } catch (error) {
      if (installed) await rm(installed, { recursive: true, force: true });
      throw error;
    }
  }
  return { workspace, app, installed };
}

// The desktop app's own session variables make a nested host fail with "Not logged in"; ANTHROPIC_* stays.
function hostEnvironment() {
  const env = { ...process.env };
  for (const name of Object.keys(env)) {
    if (/^(CLAUDE_CODE_|CLAUDE_AGENT_SDK)/u.test(name) || name === "CLAUDECODE") delete env[name];
  }
  return env;
}

function runOne(project, query, repetition) {
  return new Promise((resolve) => {
    const args = [
      "--print", "--verbose", "--output-format", "stream-json", "--no-session-persistence",
      "--setting-sources", options.install === "user" ? "user,project" : "project", "--tools", "Skill,Read,Glob,Grep", "--allowedTools", "Skill,Read,Glob,Grep",
      "--max-budget-usd", String(options.budget), ...(options.model ? ["--model", options.model] : []), query.text,
    ];
    const child = spawn(options.claude, args, { cwd: project.app, env: hostEnvironment(), stdio: ["ignore", "pipe", "pipe"] });
    const run = { id: query.id, repetition, calls: [], detail: [], triggeredAt: -1, readAt: -1, stopped: false };
    let buffer = "";
    let stderr = "";
    const timer = setTimeout(() => { run.timedOut = true; child.kill(); }, 180_000);

    const handle = (line) => {
      let message;
      try { message = JSON.parse(line); } catch { return; }
      if (message.type === "system" && message.subtype === "init") {
        run.listed = Array.isArray(message.skills) ? message.skills.includes("electron-debug") : undefined;
        run.model = message.model;
      } else if (message.type === "assistant") {
        for (const block of message.message?.content ?? []) {
          if (block.type !== "tool_use") continue;
          run.calls.push(block.name);
          const index = run.calls.length - 1;
          const text = JSON.stringify(block.input ?? {});
          run.detail.push(block.name === "Skill" ? `Skill ${block.input?.skill ?? "?"}` : `${block.name} ${text.slice(0, 90)}`);
          if (block.name === "Skill" && /electron-debug/u.test(text)) run.triggeredAt = run.triggeredAt < 0 ? index : run.triggeredAt;
          // Reading SKILL.md by path is not the Skill tool, but it shows the host found the skill some other way.
          else if (block.name !== "Skill" && /\.claude[\\/]+skills[\\/]+electron-debug|electron-debug[\\/]+SKILL/u.test(text)) {
            run.readAt = run.readAt < 0 ? index : run.readAt;
          }
        }
      } else if (message.type === "result") {
        run.cost = message.total_cost_usd;
        run.finished = true;
      }
      if (options.earlyStop && !run.stopped && (run.triggeredAt >= 0 || run.calls.length >= options.window)) {
        run.stopped = true;
        child.kill();
      }
    };

    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      lines.forEach(handle);
    });
    child.stderr.on("data", (chunk) => { stderr = (stderr + chunk).slice(-600); });
    child.once("error", (error) => { run.error = error.message; });
    child.once("close", () => {
      clearTimeout(timer);
      if (buffer.trim()) handle(buffer);
      if (run.model === undefined && !run.error) run.error = `the host never started: ${stderr.trim().slice(0, 200)}`;
      run.triggered = run.triggeredAt >= 0 && run.triggeredAt < options.window;
      // Reading SKILL.md also puts the Skill in front of the host, so "used" counts it next to the Skill tool.
      run.used = run.triggered || (run.readAt >= 0 && run.readAt < options.window);
      resolve(run);
    });
  });
}

const description = await resolveDescription();
const project = await prepareProject(description);
const removeInstalled = async () => {
  if (project.installed) await rm(project.installed, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
};
process.once("SIGINT", async () => { await removeInstalled(); process.exit(130); });
const jobs = queries.flatMap((query) => Array.from({ length: options.reps }, (_, repetition) => ({ query, repetition })));
const results = [];
let next = 0;
try {
  await Promise.all(Array.from({ length: Math.max(1, options.parallel) }, async () => {
    while (next < jobs.length) {
      const job = jobs[next++];
      const run = await runOne(project, job.query, job.repetition);
      results.push(run);
      process.stderr.write(run.error ? "x" : run.triggered ? "+" : ".");
    }
  }));
} finally {
  process.stderr.write("\n");
  await removeInstalled();
  if (!options.keep) await rm(project.workspace, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
}

const valid = results.filter((run) => !run.error);
const byId = new Map(queries.map((query) => [query.id, query]));
const rate = (runs) => (runs.length === 0 ? null : runs.filter((run) => run.triggered).length / runs.length);
const share = (runs, field) => (runs.length === 0 ? null : runs.filter((run) => run[field]).length / runs.length);
const percent = (value) => (value === null ? "n/a" : `${Math.round(value * 100)}%`);
const rows = queries.map((query) => {
  const runs = valid.filter((run) => run.id === query.id);
  return {
    id: query.id, expect: query.expect, split: query.split, runs: runs.length, rate: rate(runs),
    readSkillMd: runs.filter((run) => run.readAt >= 0 && !run.triggered).length,
    firstCalls: runs.map((run) => run.calls[0] ?? "-").join(","), text: query.text,
    otherSkills: [...new Set(runs.flatMap((run) => run.detail.filter((item) => item.startsWith("Skill ") && !/electron-debug/u.test(item))))],
  };
});
const positives = valid.filter((run) => byId.get(run.id).expect);
const negatives = valid.filter((run) => !byId.get(run.id).expect);
const costs = valid.map((run) => run.cost).filter((cost) => typeof cost === "number");
const summary = {
  variant: options.variant, descriptionChars: description?.length, model: [...new Set(valid.map((run) => run.model))].join(","),
  window: options.window, repetitions: options.reps, runs: results.length, failedRuns: results.length - valid.length,
  skillListed: valid.filter((run) => run.listed === true).length,
  triggerRateOnShouldTrigger: rate(positives), falseTriggerRateOnShouldNot: rate(negatives),
  useRateOnShouldTrigger: share(positives, "used"), falseUseRateOnShouldNot: share(negatives, "used"),
  bySplit: Object.fromEntries(["train", "validation"].map((split) => [split, {
    shouldTrigger: rate(positives.filter((run) => byId.get(run.id).split === split)),
    shouldNot: rate(negatives.filter((run) => byId.get(run.id).split === split)),
  }])),
  totalCostUsd: costs.length === valid.length ? Number(costs.reduce((sum, cost) => sum + cost, 0).toFixed(3)) : null,
};

console.log(`variant=${summary.variant} model=${summary.model} runs=${summary.runs} failed=${summary.failedRuns} listed=${summary.skillListed}`);
for (const row of rows) {
  const verdict = row.expect ? (row.rate >= 0.5 ? "ok  " : "MISS") : (row.rate > 0 ? "FALSE" : "ok  ");
  console.log(`${verdict} ${row.id.padEnd(4)} ${row.split.padEnd(10)} ${percent(row.rate).padStart(4)} (${row.runs} runs, read SKILL.md instead: ${row.readSkillMd}) first calls: ${row.firstCalls}${row.otherSkills.length ? `  other skills: ${row.otherSkills.join("; ")}` : ""}`);
}
console.log(`should trigger: ${percent(summary.triggerRateOnShouldTrigger)}   should not: ${percent(summary.falseTriggerRateOnShouldNot)}` +
  `   (used incl. SKILL.md read: ${percent(summary.useRateOnShouldTrigger)} / ${percent(summary.falseUseRateOnShouldNot)})` +
  `   train ${percent(summary.bySplit.train.shouldTrigger)}/${percent(summary.bySplit.train.shouldNot)}` +
  `   validation ${percent(summary.bySplit.validation.shouldTrigger)}/${percent(summary.bySplit.validation.shouldNot)}` +
  `   cost ${summary.totalCostUsd ?? "n/a (early stop)"}`);
if (summary.failedRuns > 0) {
  console.log(`failed runs: ${results.filter((run) => run.error).map((run) => `${run.id}: ${run.error}`).slice(0, 3).join(" | ")}`);
}
if (options.out) await writeFile(options.out, `${JSON.stringify({ summary, rows, results }, null, 2)}\n`);
process.exitCode = summary.failedRuns === results.length ? 1 : 0;
