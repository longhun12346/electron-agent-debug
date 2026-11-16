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
import { redact } from "../src/redact.js";
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
    assert.equal(JSON.stringify(thrown).includes("hunter2hunter2"), false);

    const big = await manager.inspector.evaluate({ scope: "main", expression: "big", maxResultBytes: 256 });
    assert.ok(big.ok);
    assert.equal(big.data.truncated, true);
    assert.equal(big.data.value, undefined);
    assert.equal(big.data.text?.length, 256);

    const secret = await manager.inspector.evaluate({ scope: "main", expression: "secret" });
    assert.ok(secret.ok);
    assert.deepEqual(secret.data.value, { token: "[REDACTED]", ok: true });

    const nan = await manager.inspector.evaluate({ scope: "main", expression: "nan" });
    assert.ok(nan.ok);
    assert.equal(nan.data.text, "NaN");

    const plain = await manager.inspector.evaluate({ scope: "main", expression: "plain-promise" });
    assert.ok(plain.ok);
    assert.deepEqual(plain.data.value, { awaited: true });

    const topLevel = await manager.inspector.evaluate({ scope: "main", expression: "await-top-level" });
    assert.ok(topLevel.ok);
    assert.deepEqual(topLevel.data.value, { awaited: true });

    const hung = await manager.inspector.evaluate({ scope: "main", expression: "never", timeoutMs: 100 });
    assert.equal(hung.ok, false);
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

test("dom snapshot renders the accessibility tree compactly and within the node budget", { timeout: 20_000 }, async () => {
  await withAttachedApp({}, async (manager) => {
    const snapshot = await manager.inspector.domSnapshot({});
    assert.ok(snapshot.ok, JSON.stringify(snapshot));
    assert.equal(snapshot.data.url, "app://fixture/#/after-navigation");
    assert.equal(snapshot.data.text, [
      'RootWebArea "Fixture"',
      '  button "Save" [disabled]',
      '  textbox "Name" value="token=[REDACTED]"',
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

test("redact masks common secrets and leaves ordinary text alone", () => {
  assert.equal(redact("Authorization: Bearer abc.def-ghi_jkl123"), "Authorization: [REDACTED]");
  assert.equal(redact('{"access_token":"abc123","name":"x"}'), '{"access_token":"[REDACTED]","name":"x"}');
  assert.equal(redact("password=hunter2 &x=1"), "password=[REDACTED] &x=1");
  const nested = (value: string) => JSON.stringify({ log: JSON.stringify({ password: value, name: "x" }) });
  assert.equal(redact(nested("hunter2")), nested("[REDACTED]"));
  assert.equal(redact("window created in 120ms"), "window created in 120ms");
});
