import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { WebSocketServer, type WebSocket } from "ws";
import { requireElectron } from "../src/app-script.js";
import type { RuntimeConfig } from "../src/config.js";
import { instrumentDialogsScript } from "../src/dialogs.js";
import { isTruthy } from "../src/evaluate.js";
import { instrumentIpcScript, ipcEvent } from "../src/ipc.js";
import { SessionManager } from "../src/sessions/session-manager.js";
import { allTools } from "../src/tools/index.js";

// Cases where a call used to succeed and answer something other than what was asked: events deleted without being
// returned, a level filter that missed half the warnings, a misspelled argument that was ignored, an answer with no
// size limit, a wait that could not succeed, and history stamped with the time of the attach.

function config(overrides: Partial<RuntimeConfig> = {}): RuntimeConfig {
  return {
    requestTimeoutMs: 1_000, discoveryTimeoutMs: 1_000, maxLogEvents: 500, maxLogBytes: 1_000_000,
    maxProtocolMessageBytes: 1_000_000, allowEval: true, ...overrides,
  };
}

interface Page { id: string; title: string; url: string }

// A renderer debugging port with the given pages. `answer` gives the result of a request; without it every request
// succeeds with an empty result.
async function startRenderer(pages: Page[], answer: (method: string) => unknown = () => ({})) {
  const http = createServer();
  const sockets = new WebSocketServer({ server: http });
  const open = new Set<WebSocket>();
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const { port } = http.address() as { port: number };
  http.on("request", (request, response) => {
    if (request.url !== "/json/list") {
      response.writeHead(404).end();
      return;
    }
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify(pages.map((page) => ({
      ...page, type: "page", webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/page/${page.id}`,
    }))));
  });
  sockets.on("connection", (socket) => {
    open.add(socket);
    socket.on("close", () => open.delete(socket));
    socket.on("message", (raw) => {
      const message = JSON.parse(raw.toString()) as { id: number; method: string };
      socket.send(JSON.stringify({ id: message.id, result: answer(message.method) }));
    });
  });
  return {
    endpoint: `http://127.0.0.1:${port}`,
    emit(method: string, params: unknown) {
      for (const socket of open) socket.send(JSON.stringify({ method, params }));
    },
    async close() {
      for (const socket of open) socket.terminate();
      await new Promise<void>((resolve) => sockets.close(() => resolve()));
      await new Promise<void>((resolve) => http.close(() => resolve()));
    },
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 40));
const board: Page = { id: "window-a", title: "Board", url: "app://board" };

function fill(manager: SessionManager, process: "main" | "renderer", count: number, level = "log"): void {
  for (let index = 0; index < count; index += 1) {
    manager[process].events.add({
      process, message: `${process} ${index}`, observedAt: "2026-01-01T00:00:00.000Z", level, kind: "console",
    });
  }
}

test("clear without a limit deletes the 100 events it returned and keeps the rest", () => {
  const manager = new SessionManager(config());
  fill(manager, "main", 150);
  const first = manager.logs({ process: "main", clear: true });
  assert.equal(first.events.length, 100);
  assert.equal(first.events[0]?.message, "main 50");
  assert.equal(manager.main.events.size, 50, "the 50 events that were not returned are still there");
  assert.equal(manager.logs({ process: "main", limit: 500 }).events.at(-1)?.message, "main 49");

  const second = manager.logs({ process: "main", clear: true });
  assert.equal(second.events.length, 50);
  assert.equal(manager.main.events.size, 0);
});

test("clear across channels keeps the events of every channel that were not returned", () => {
  const manager = new SessionManager(config());
  fill(manager, "main", 80);
  fill(manager, "renderer", 80);
  const cleared = manager.logs({ clear: true });
  assert.equal(cleared.events.length, 100);
  assert.equal(manager.main.events.size + manager.renderer.events.size, 60);
  assert.equal(manager.main.events.size, 60, "the oldest 60 are all from the main channel");
  assert.equal(manager.logs({ limit: 500, clear: true }).events.length, 60);
  assert.equal(manager.main.events.size + manager.renderer.events.size, 0);
});

test("a console warning and the server's own warnings share one level, and warn finds both", () => {
  const manager = new SessionManager(config());
  fill(manager, "renderer", 1, "warning");
  manager.main.events.add(ipcEvent("main", JSON.stringify({ type: "send", channel: "app:ping", ok: true, ms: 0, listeners: 0 }))!);
  fill(manager, "main", 1, "error");
  for (const level of ["warn", "warning"]) {
    assert.deepEqual(manager.logs({ level }).events.map((event) => [event.process, event.level]),
      [["renderer", "warning"], ["main", "warning"]], `level: ${level}`);
  }
  assert.equal(manager.logs({ level: "error" }).events.length, 1);
});

test("every tool that takes arguments refuses one it does not know", () => {
  const valid: Record<string, Record<string, unknown>> = {
    electron_attach: {}, electron_status: {}, electron_targets: {}, electron_logs: {},
    electron_evaluate: { scope: "main", expression: "1" },
    electron_wait_for: { log: { contains: "ready" } },
    electron_screenshot: {}, electron_dom_snapshot: {},
    electron_click: { ref: "abc1" }, electron_type: { ref: "abc1", text: "x" },
  };
  assert.deepEqual(Object.keys(valid).sort(), allTools.map((tool) => tool.name).sort());
  for (const tool of allTools) {
    assert.equal(tool.inputSchema.safeParse(valid[tool.name]).success, true, `${tool.name}: the valid call`);
    // electron_status has no arguments: nothing a stray one could change.
    if (tool.name === "electron_status") continue;
    const misspelled = tool.inputSchema.safeParse({ ...valid[tool.name], after_seq: 5 });
    assert.equal(misspelled.success, false, `${tool.name} accepted an unknown argument`);
    assert.match(misspelled.error?.message ?? "", /after_seq/u, `${tool.name}: the error names the argument`);
  }
  const waitFor = allTools.find((tool) => tool.name === "electron_wait_for")!;
  // The mistakes hosts make: timeout for timeoutMs, and the timeout put inside the condition.
  assert.equal(waitFor.inputSchema.safeParse({ log: { contains: "x" }, timeout: 30_000 }).success, false);
  assert.equal(waitFor.inputSchema.safeParse({ log: { contains: "x", timeoutMs: 30_000 } }).success, false);
  assert.equal(waitFor.inputSchema.safeParse({ expression: { scope: "main", expression: "1", timeoutMs: 5 } }).success, false);
});

test("a page with a very long url or title does not make the answers grow with it", async () => {
  const long = { id: "window-a", title: "T".repeat(3_000), url: `data:text/html,${"x".repeat(60_000)}` };
  const renderer = await startRenderer([long], (method) => (method === "Accessibility.getFullAXTree" ? { nodes: [] } : {}));
  const manager = new SessionManager(config());
  try {
    const attached = await manager.attach({ rendererUrl: renderer.endpoint });
    assert.ok(attached.ok);
    assert.ok(JSON.stringify(attached).length < 20_000, `attach answered ${JSON.stringify(attached).length} characters`);
    const [listed] = attached.data.targets;
    assert.equal(listed?.url.length, 4_097);
    assert.ok(listed?.url.endsWith("…"));
    assert.equal(listed?.urlTruncatedFrom, long.url.length);
    assert.equal(listed?.title.length, 513);
    assert.equal(listed?.titleTruncatedFrom, 3_000);
    assert.equal(attached.data.selectedTarget?.urlTruncatedFrom, long.url.length);
    assert.ok(JSON.stringify(manager.status()).length < 20_000);

    // The cut is in the answer only: the page is still chosen by its id, and by its whole url.
    const byId = await manager.refreshTargets({ targetId: "window-a" });
    assert.ok(byId.ok && byId.data.errors.length === 0, JSON.stringify(byId).slice(0, 300));
    const byUrl = await manager.refreshTargets({ url: long.url });
    assert.ok(byUrl.ok && byUrl.data.selectedTarget?.id === "window-a");
    assert.ok(JSON.stringify(byUrl).length < 20_000);

    const snapshot = await manager.inspector.domSnapshot({});
    assert.ok(snapshot.ok);
    assert.equal(String(snapshot.data.url).length, 4_097);
    assert.equal(snapshot.data.urlTruncatedFrom, long.url.length);
  } finally {
    await manager.close();
    await renderer.close();
  }
});

test("a short url and title are returned as they are", async () => {
  const renderer = await startRenderer([board]);
  const manager = new SessionManager(config());
  try {
    const attached = await manager.attach({ rendererUrl: renderer.endpoint });
    assert.ok(attached.ok);
    assert.deepEqual(
      { ...attached.data.targets[0], webSocketDebuggerUrl: undefined },
      { id: "window-a", type: "page", title: "Board", url: "app://board", webSocketDebuggerUrl: undefined },
    );
  } finally {
    await manager.close();
    await renderer.close();
  }
});

test("events carry the time the app produced them, so replayed history is not dated at the attach", async () => {
  const renderer = await startRenderer([board]);
  const manager = new SessionManager(config());
  try {
    await manager.attach({ rendererUrl: renderer.endpoint });
    const earlier = Date.now() - 90_000;
    renderer.emit("Runtime.consoleAPICalled", { type: "log", args: [{ value: "printed earlier" }], timestamp: earlier });
    renderer.emit("Log.entryAdded", { entry: { level: "error", text: "failed earlier", timestamp: earlier + 1 } });
    renderer.emit("Runtime.exceptionThrown", { timestamp: earlier + 2, exceptionDetails: { text: "Uncaught earlier" } });
    renderer.emit("Runtime.consoleAPICalled", { type: "log", args: [{ value: "no timestamp" }] });
    // Not a time since the epoch (a monotonic clock, or a timestamp from the future): the time of receipt is used.
    renderer.emit("Runtime.consoleAPICalled", { type: "log", args: [{ value: "monotonic" }], timestamp: 123_456.7 });
    renderer.emit("Runtime.consoleAPICalled", { type: "log", args: [{ value: "future" }], timestamp: Date.now() + 3_600_000 });
    await settle();

    const at = (message: string) => Date.parse(manager.logs({ process: "renderer" }).events
      .find((event) => event.message.startsWith(message))?.observedAt ?? "");
    assert.equal(at("printed earlier"), earlier);
    assert.equal(at("failed earlier"), earlier + 1);
    assert.equal(at("Uncaught earlier"), earlier + 2);
    for (const message of ["no timestamp", "monotonic", "future"]) {
      assert.ok(Math.abs(at(message) - Date.now()) < 5_000, `${message} is dated at receipt`);
    }
    const recent = manager.logs({ process: "renderer", since: new Date(Date.now() - 30_000).toISOString() }).events
      .filter((event) => event.kind !== "connection").map((event) => event.message);
    assert.deepEqual(recent, ["no timestamp", "monotonic", "future"], "since leaves out what was produced earlier");
  } finally {
    await manager.close();
    await renderer.close();
  }
});

test("a crashed page says how to bring it back, since its own evaluation is refused", async () => {
  const renderer = await startRenderer([board]);
  const manager = new SessionManager(config());
  try {
    await manager.attach({ rendererUrl: renderer.endpoint });
    renderer.emit("Inspector.targetCrashed", {});
    await settle();
    const fromStatus = manager.status().renderer.error;
    assert.equal(fromStatus?.code, "TARGET_CRASHED");
    assert.match(fromStatus?.hint ?? "", /electron_evaluate\(main\)[\s\S]*webContents\.reload\(\)/u);
    const evaluated = await manager.inspector.evaluate({ scope: "renderer", expression: "location.reload()" });
    assert.ok(!evaluated.ok);
    assert.equal(evaluated.error.code, "TARGET_CRASHED");
    assert.match(evaluated.error.hint ?? "", /webContents\.reload\(\)/u);
  } finally {
    await manager.close();
    await renderer.close();
  }
});

test("an expression wait on a channel that is not connected fails at once with the reason", async () => {
  const manager = new SessionManager(config());
  for (const scope of ["main", "renderer", "utility"] as const) {
    const started = Date.now();
    const waited = await manager.inspector.waitFor({
      condition: { kind: "expression", scope, expression: "true" }, timeoutMs: 5_000,
    });
    assert.ok(!waited.ok);
    assert.equal(waited.error.code, "SESSION_DISCONNECTED", scope);
    assert.match(waited.error.hint ?? "", /electron_attach/u);
    assert.ok(Date.now() - started < 1_000, `${scope}: waited ${Date.now() - started}ms`);
  }
});

test("an expression wait keeps waiting through a crash, which a reload ends on the same connection", async () => {
  const renderer = await startRenderer([board], (method) =>
    (method === "Runtime.evaluate" ? { result: { type: "boolean", value: true } } : {}));
  const manager = new SessionManager(config());
  try {
    await manager.attach({ rendererUrl: renderer.endpoint });
    renderer.emit("Inspector.targetCrashed", {});
    await settle();
    setTimeout(() => renderer.emit("Inspector.targetReloadedAfterCrash", {}), 300);
    const waited = await manager.inspector.waitFor({
      condition: { kind: "expression", scope: "renderer", expression: "ready" }, timeoutMs: 5_000, intervalMs: 50,
    });
    assert.ok(waited.ok, JSON.stringify(waited));
    assert.ok(Number(waited.data.elapsedMs) >= 200, "it matched only after the reload");
  } finally {
    await manager.close();
    await renderer.close();
  }
});

test("an expression wait matches every truthy result, also one without a JSON value", async () => {
  const truthy = { type: "number", text: "x", truncated: false, bytes: 1 };
  assert.equal(isTruthy({ ...truthy, text: "Infinity" }), true);
  assert.equal(isTruthy({ ...truthy, text: "-Infinity" }), true);
  assert.equal(isTruthy({ ...truthy, type: "bigint", text: "1n" }), true);
  assert.equal(isTruthy({ ...truthy, type: "string", text: "\"xxxx", truncated: true }), true);
  for (const text of ["NaN", "0", "-0", "0n"]) assert.equal(isTruthy({ ...truthy, text }), false, text);
  assert.equal(isTruthy({ type: "undefined", truncated: false, bytes: 0 }), false);
  assert.equal(isTruthy({ type: "string", value: "", truncated: false, bytes: 2 }), false);
  assert.equal(isTruthy({ type: "object", value: {}, truncated: false, bytes: 2 }), true);

  const renderer = await startRenderer([board], (method) =>
    (method === "Runtime.evaluate" ? { result: { type: "bigint", unserializableValue: "1n" } } : {}));
  const manager = new SessionManager(config());
  try {
    await manager.attach({ rendererUrl: renderer.endpoint });
    const waited = await manager.inspector.waitFor({
      condition: { kind: "expression", scope: "renderer", expression: "1n" }, timeoutMs: 1_000,
    });
    assert.ok(waited.ok, JSON.stringify(waited));
    assert.equal(waited.data.value, "1n");
  } finally {
    await manager.close();
    await renderer.close();
  }
});

test("the scripts run in the app reach Electron without a dynamic import, with or without process.mainModule", () => {
  // An evaluation cannot use import(): "A dynamic import callback was not specified".
  for (const script of [instrumentIpcScript, instrumentDialogsScript]) {
    assert.equal(/\bimport\s*\(/u.test(script), false);
    assert.ok(script.includes(requireElectron));
  }
  const load = new Function("process", `return ${requireElectron}`) as (process: unknown) => unknown;
  assert.equal(load({ mainModule: { require: (name: string) => `main:${name}` } }), "main:electron");
  assert.equal(load({
    execPath: "/opt/app/electron",
    getBuiltinModule: (name: string) => ({ createRequire: (from: string) => (id: string) => `${name}|${from}|${id}` }),
  }), "node:module|/opt/app/electron|electron");
});
