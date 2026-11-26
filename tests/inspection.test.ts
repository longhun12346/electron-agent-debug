import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { renderAxTree } from "../src/ax-tree.js";
import type { RuntimeConfig } from "../src/config.js";
import { DiagnosticException } from "../src/errors.js";
import { SessionManager } from "../src/sessions/session-manager.js";

const fakeApp = path.join(path.dirname(fileURLToPath(import.meta.url)), "helpers", "fake-electron-app.cjs");

function config(overrides: Partial<RuntimeConfig> = {}): RuntimeConfig {
  return {
    requestTimeoutMs: 2_000,
    discoveryTimeoutMs: 2_000,
    maxLogEvents: 200,
    maxLogBytes: 200_000,
    maxProtocolMessageBytes: 1_000_000,
    allowEval: true,
    ...overrides,
  };
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolve(port));
    });
  });
}

interface FakeApp {
  mainUrl: string;
  rendererUrl: string;
}

async function attachFakeApp(manager: SessionManager, app: FakeApp): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const result = await manager.attach({ mainUrl: app.mainUrl, rendererUrl: app.rendererUrl });
    if (result.ok && result.data.main.online && result.data.renderer.online) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.fail("fixture app must be attachable");
}

// The agent starts the app itself; the fixture stands in for `electron . --inspect=… --remote-debugging-port=…`.
async function withAttachedApp(
  overrides: Partial<RuntimeConfig>,
  body: (manager: SessionManager) => Promise<void>,
): Promise<void> {
  const mainPort = await freePort();
  const rendererPort = await freePort();
  const child: ChildProcess = spawn(process.execPath, [
    fakeApp, `--inspect=${mainPort}`, `--remote-debugging-port=${rendererPort}`,
  ], { stdio: "ignore" });
  const manager = new SessionManager(config(overrides));
  try {
    await attachFakeApp(manager, {
      mainUrl: `http://127.0.0.1:${mainPort}`,
      rendererUrl: `http://127.0.0.1:${rendererPort}`,
    });
    await body(manager);
  } finally {
    await manager.close();
    child.kill();
  }
}

test("evaluate runs in both processes and shapes results", { timeout: 20_000 }, async () => {
  await withAttachedApp({}, async (manager) => {
    const main = await manager.inspector.evaluate({ scope: "main", expression: "1+1" });
    assert.ok(main.ok);
    assert.equal(main.data.value, "main:1+1");
    const renderer = await manager.inspector.evaluate({ scope: "renderer", expression: "document.title" });
    assert.ok(renderer.ok);
    assert.equal(renderer.data.value, "renderer:document.title");
    assert.equal(renderer.data.targetId, "page-1");

    const thrown = await manager.inspector.evaluate({ scope: "main", expression: "throw" });
    assert.equal(thrown.ok ? "" : thrown.error.code, "EVALUATION_FAILED");
    assert.equal(thrown.ok ? "" : thrown.error.message, "Error: boom password=hunter2hunter2");

    const big = await manager.inspector.evaluate({ scope: "main", expression: "big", maxResultBytes: 256 });
    assert.ok(big.ok);
    assert.equal(big.data.truncated, true);
    assert.equal(big.data.value, undefined);
    assert.equal(big.data.text?.length, 256);

    // The limit is in UTF-8 bytes: `"` + 85 three-byte characters is exactly 256 bytes, with no split character.
    const wide = await manager.inspector.evaluate({ scope: "main", expression: "wide", maxResultBytes: 256 });
    assert.ok(wide.ok);
    assert.equal(wide.data.truncated, true);
    assert.equal(wide.data.text, `"${"中".repeat(85)}`);
    const tight = await manager.inspector.evaluate({ scope: "main", expression: "wide", maxResultBytes: 257 });
    assert.ok(tight.ok);
    assert.equal(tight.data.text, `"${"中".repeat(85)}`);

    const secret = await manager.inspector.evaluate({ scope: "main", expression: "secret" });
    assert.ok(secret.ok);
    assert.deepEqual(secret.data.value, { token: "abc12345678", ok: true });

    const nan = await manager.inspector.evaluate({ scope: "main", expression: "nan" });
    assert.ok(nan.ok);
    assert.equal(nan.data.text, "NaN");

    const plain = await manager.inspector.evaluate({ scope: "main", expression: "plain-promise" });
    assert.ok(plain.ok);
    assert.deepEqual(plain.data.value, { awaited: true });

    const topLevel = await manager.inspector.evaluate({ scope: "main", expression: "await-top-level" });
    assert.ok(topLevel.ok);
    assert.deepEqual(topLevel.data.value, { awaited: true });

    const redeclared = await manager.inspector.evaluate({ scope: "main", expression: "const again = 2; again" });
    assert.ok(redeclared.ok, JSON.stringify(redeclared));
    assert.equal(redeclared.data.value, 2);

    const hung = await manager.inspector.evaluate({ scope: "main", expression: "never", timeoutMs: 100 });
    assert.equal(hung.ok, false);
  });
});

test("evaluate retries any compile-time SyntaxError in repl mode but never re-runs code that already ran", { timeout: 20_000 }, async () => {
  await withAttachedApp({}, async (manager) => {
    const runsOf = async (expression: string) => {
      const counted = await manager.inspector.evaluate({ scope: "main", expression: `runs:${expression}` });
      assert.ok(counted.ok);
      return counted.data.value;
    };

    // `await import(…)` fails to compile with a different message than `await x`; it must still reach repl mode.
    const imported = await manager.inspector.evaluate({ scope: "main", expression: "await-import" });
    assert.ok(imported.ok, JSON.stringify(imported));
    assert.equal(imported.data.value, "imported");
    assert.equal(await runsOf("await-import"), 2, "plain mode failed to compile, repl mode ran once");

    // A SyntaxError thrown by running code (JSON.parse, new Function) has a stack and must not run twice.
    const runtime = await manager.inspector.evaluate({ scope: "main", expression: "runtime-syntax-error" });
    assert.equal(runtime.ok, false);
    assert.equal(await runsOf("runtime-syntax-error"), 1);

    // The "already been declared" wording alone does not make an error a compile error: this one came from running
    // code, so it is reported once and not run again in repl mode or in a block.
    const redeclared = await manager.inspector.evaluate({ scope: "main", expression: "runtime-redeclared" });
    assert.equal(redeclared.ok, false);
    assert.equal(await runsOf("runtime-redeclared"), 1);

    // `await (…)` is a call of a variable named await and fails at run time. When nothing precedes it nothing has run,
    // so it is retried; after other statements earlier code may have run, so it is not, and the error says what to write.
    const awaitFirst = await manager.inspector.evaluate({ scope: "main", expression: "await-call" });
    assert.ok(awaitFirst.ok, JSON.stringify(awaitFirst));
    assert.equal(awaitFirst.data.value, 1);
    assert.equal(await runsOf("await-call"), 2);
    const awaitLater = await manager.inspector.evaluate({ scope: "main", expression: "x = 1; await-call" });
    assert.ok(!awaitLater.ok);
    assert.equal(awaitLater.error.code, "EVALUATION_FAILED");
    assert.match(awaitLater.error.message, /await is not defined.*async/u);
    assert.equal(await runsOf("x = 1; await-call"), 1);

    // A genuine syntax error is reported as such after the one retry.
    const genuine = await manager.inspector.evaluate({ scope: "main", expression: "genuine-syntax-error" });
    assert.ok(!genuine.ok);
    assert.match(genuine.error.message, /^SyntaxError: Unexpected token '='/u);
    assert.equal(await runsOf("genuine-syntax-error"), 2);
  });
});

test("evaluate and expression waits are refused when the host disables evaluation", { timeout: 20_000 }, async () => {
  await withAttachedApp({ allowEval: false }, async (manager) => {
    const result = await manager.inspector.evaluate({ scope: "renderer", expression: "1" });
    assert.equal(result.ok ? "" : result.error.code, "EVALUATION_NOT_ALLOWED");
    const gated = await manager.inspector.waitFor({
      condition: { kind: "expression", scope: "main", expression: "1" }, timeoutMs: 300,
    });
    assert.equal(gated.ok ? "" : gated.error.code, "EVALUATION_NOT_ALLOWED");
    const snapshot = await manager.inspector.domSnapshot({});
    assert.ok(snapshot.ok, "read-only accessibility snapshot works without eval");
  });
});

test("wait_for covers log, expression and timeout", { timeout: 30_000 }, async () => {
  await withAttachedApp({}, async (manager) => {
    const log = await manager.inspector.waitFor({
      condition: { kind: "log", contains: "renderer ready", process: "renderer" }, timeoutMs: 2_000,
    });
    assert.ok(log.ok);
    assert.equal((log.data.event as { process: string }).process, "renderer");

    const afterEverything = await manager.inspector.waitFor({
      condition: { kind: "log", contains: "renderer ready", afterSeq: manager.logs({}).lastSeq }, timeoutMs: 300,
    });
    assert.equal(afterEverything.ok ? "" : afterEverything.error.code, "WAIT_TIMEOUT");

    const expression = await manager.inspector.waitFor({
      condition: { kind: "expression", scope: "renderer", expression: "poll" }, timeoutMs: 5_000, intervalMs: 50,
    });
    assert.ok(expression.ok, JSON.stringify(expression));
    assert.equal(expression.data.value, true);
  });
});

test("screenshot writes a private PNG into the configured directory", { timeout: 20_000 }, async () => {
  const outputDir = await mkdtemp(path.join(tmpdir(), "ead-shots-"));
  try {
    await withAttachedApp({ outputDir }, async (manager) => {
      const shot = await manager.inspector.screenshot({});
      assert.ok(shot.ok, JSON.stringify(shot));
      const file = shot.data.path as string;
      assert.equal(path.dirname(file), outputDir);
      const bytes = await readFile(file);
      assert.deepEqual([...bytes.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
      assert.equal(shot.data.bytes, bytes.length);
      assert.equal(shot.data.targetId, "page-1");
      assert.equal(shot.data.url, "app://fixture/#/after-navigation");
      assert.equal((await readdir(outputDir)).length, 1);
    });
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
});

test("screenshot and snapshot fail with structured errors when the renderer is offline", async () => {
  const manager = new SessionManager(config());
  try {
    const shot = await manager.inspector.screenshot({});
    assert.equal(shot.ok ? "" : shot.error.code, "SESSION_DISCONNECTED");
    const snapshot = await manager.inspector.domSnapshot({});
    assert.equal(snapshot.ok ? "" : snapshot.error.code, "SESSION_DISCONNECTED");
  } finally {
    await manager.close();
  }
});

test("screenshot explains a timed-out capture by error reason, not by message wording", async () => {
  const manager = new SessionManager(config());
  try {
    const fail = (error: DiagnosticException) => {
      manager.renderer.request = async () => { throw error; };
    };
    const timedOut = new DiagnosticException("PROTOCOL_ERROR", "request timed out", {
      retryable: true, details: { reason: "timeout" },
    });
    fail(timedOut);
    const shot = await manager.inspector.screenshot({});
    assert.equal(shot.ok ? "" : shot.error.code, "PROTOCOL_ERROR");
    assert.match(shot.ok ? "" : shot.error.message, /隐藏或最小化/u);
    assert.equal(timedOut.diagnostic.message, "request timed out");

    fail(new DiagnosticException("PROTOCOL_ERROR", "页面返回了错误：超时设置无效"));
    const other = await manager.inspector.screenshot({});
    assert.doesNotMatch(other.ok ? "" : other.error.message, /隐藏或最小化/u);
  } finally {
    await manager.close();
  }
});

test("dom snapshot renders the accessibility tree compactly and within the node budget", { timeout: 20_000 }, async () => {
  await withAttachedApp({}, async (manager) => {
    const snapshot = await manager.inspector.domSnapshot({});
    assert.ok(snapshot.ok, JSON.stringify(snapshot));
    assert.equal(snapshot.data.url, "app://fixture/#/after-navigation");
    assert.equal(snapshot.data.text, [
      'RootWebArea "Fixture"',
      '  button "Save" [disabled]',
      '  textbox "Name" value="token=abcdef123456"',
      '  heading "Settings" [level=2]',
    ].join("\n"));
  });

  const nodes = Array.from({ length: 10 }, (_, index) => ({
    nodeId: String(index), role: { value: "button" }, name: { value: `b${index}` },
  }));
  const limited = renderAxTree(nodes, 3);
  assert.equal(limited.nodeCount, 3);
  assert.equal(limited.truncated, true);
});

test("attach installs the wrappers the agent asks for, remembers the choice, and reports what is installed", { timeout: 20_000 }, async () => {
  const mainPort = await freePort();
  const rendererPort = await freePort();
  const child: ChildProcess = spawn(process.execPath, [
    fakeApp, `--inspect=${mainPort}`, `--remote-debugging-port=${rendererPort}`,
  ], { stdio: "ignore" });
  const endpoints = { mainUrl: `http://127.0.0.1:${mainPort}`, rendererUrl: `http://127.0.0.1:${rendererPort}` };
  const wrapperWarnings = (manager: SessionManager) => manager.logs({ process: "main", limit: 100 }).events
    .filter((event) => event.kind === "protocol" && /追踪|对话框监测/u.test(event.message)).map((event) => event.message);
  try {
    const none = new SessionManager(config());
    try {
      let result = await none.attach({ ...endpoints, instrument: [] });
      for (let attempt = 0; attempt < 50 && !(result.ok && result.data.main.online); attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        result = await none.attach({ ...endpoints, instrument: [] });
      }
      assert.ok(result.ok && result.data.main.online);
      assert.deepEqual(result.data.instrumented, []);
      assert.deepEqual(wrapperWarnings(none), [], "nothing was installed, so nothing could fail to install");
      // The choice is remembered: a later attach without the option does not install what was left out.
      const again = await none.attach(endpoints);
      assert.ok(again.ok);
      assert.deepEqual(wrapperWarnings(none), []);
    } finally {
      await none.close();
    }

    const defaults = new SessionManager(config());
    try {
      const result = await defaults.attach(endpoints);
      assert.ok(result.ok && result.data.main.online);
      assert.deepEqual(result.data.instrumented, []);
      assert.deepEqual(wrapperWarnings(defaults), [], "a plain attach tries to install nothing");
      // Waiting for an IPC event that nothing records says so, instead of just timing out.
      const waited = await defaults.inspector.waitFor({
        condition: { kind: "log", contains: "IPC invoke notes:save", process: "main" }, timeoutMs: 300,
      });
      assert.ok(!waited.ok);
      assert.match(String((waited.error.details as { hint?: string } | undefined)?.hint), /instrument/u);
    } finally {
      await defaults.close();
    }

    const asked = new SessionManager(config());
    try {
      const result = await asked.attach({ ...endpoints, instrument: ["ipc", "dialogs"] });
      assert.ok(result.ok && result.data.main.online);
      assert.ok(wrapperWarnings(asked).length > 0, "when asked, both wrappers are tried (the fake app cannot take them)");
    } finally {
      await asked.close();
    }
  } finally {
    child.kill();
  }
});

test("a message cut to the length limit says so, with its original length", () => {
  const manager = new SessionManager(config());
  manager.main.events.add({
    process: "main", message: "x".repeat(9_000), observedAt: "2026-01-01T00:00:00.000Z", level: "log", kind: "console",
    data: { type: "log" },
  });
  const [stored] = manager.logs({ process: "main" }).events;
  assert.equal(stored?.message.length, 8_192);
  assert.deepEqual(stored?.data, { type: "log", messageTruncatedFrom: 9_000 });
});
