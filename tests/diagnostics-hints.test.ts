import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { createServer as createTcpServer } from "node:net";
import test from "node:test";
import { WebSocketServer, type WebSocket } from "ws";
import type { RuntimeConfig } from "../src/config.js";
import { DialogTracker } from "../src/dialogs.js";
import { SessionManager } from "../src/sessions/session-manager.js";

// Attach failures, target changes and dialogs: what the agent is told when the evidence may not be what it expects.

type Target = { id: string; type: string; title: string; url: string };
type Responder = (method: string, params: Record<string, unknown>) => unknown;

interface Mock {
  endpoint: string;
  setTargets(targets: Target[]): void;
  push(method: string, params?: unknown): void;
  dropSockets(): void;
  close(): Promise<void>;
}

async function startMock(
  targets: Target[],
  options: { userAgent?: string; respond?: Responder } = {},
): Promise<Mock> {
  const http = createServer();
  const ws = new WebSocketServer({ server: http });
  const sockets = new Set<WebSocket>();
  let current = targets;
  ws.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("message", (raw) => {
      const message = JSON.parse(raw.toString()) as { id: number; method: string; params?: Record<string, unknown> };
      const result = options.respond?.(message.method, message.params ?? {}) ?? {};
      if (result === "hang") return;
      socket.send(JSON.stringify({ id: message.id, result }));
    });
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const port = (http.address() as { port: number }).port;
  http.on("request", (request, response) => {
    if (request.url === "/json/version" && options.userAgent !== undefined) {
      response.end(JSON.stringify({ "User-Agent": options.userAgent }));
      return;
    }
    if (request.url !== "/json/list") {
      response.writeHead(404).end();
      return;
    }
    response.end(JSON.stringify(current.map((target) => ({
      ...target, webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/page/${target.id}`,
    }))));
  });
  return {
    endpoint: `http://127.0.0.1:${port}`,
    setTargets(next) { current = next; },
    push(method, params = {}) {
      for (const socket of sockets) socket.send(JSON.stringify({ method, params }));
    },
    dropSockets() {
      for (const socket of sockets) socket.close();
    },
    async close() {
      for (const socket of sockets) socket.terminate();
      await new Promise<void>((resolve) => ws.close(() => resolve()));
      await new Promise<void>((resolve) => (http as Server).close(() => resolve()));
    },
  };
}

function config(overrides: Partial<RuntimeConfig> = {}): RuntimeConfig {
  return {
    requestTimeoutMs: 500,
    discoveryTimeoutMs: 1_000,
    maxLogEvents: 100,
    maxLogBytes: 100_000,
    maxProtocolMessageBytes: 100_000,
    allowEval: true,
    ...overrides,
  };
}

async function closedPort(): Promise<string> {
  const server = createTcpServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return `http://127.0.0.1:${port}`;
}

const until = async (check: () => boolean, label: string) => {
  const deadline = Date.now() + 3_000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`${label} timeout`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};

const page = (id: string, title = id, url = `app://${id}`): Target => ({ id, type: "page", title, url });

test("a closed port keeps the underlying error and adds a launch hint per channel", async () => {
  const manager = new SessionManager(config());
  const endpoint = await closedPort();
  const result = await manager.attach({ mainUrl: endpoint, rendererUrl: endpoint });
  assert.ok(result.ok);
  const [main, renderer] = result.data.errors;
  assert.equal(main?.code, "MAIN_INSPECTOR_UNAVAILABLE");
  assert.match(main?.message ?? "", /ECONNREFUSED/u, "the transport error stays in the message");
  assert.match(main?.hint ?? "", /--inspect/u);
  assert.equal(renderer?.code, "RENDERER_CDP_UNAVAILABLE");
  assert.match(renderer?.hint ?? "", /--remote-debugging-port/u);
  assert.match(renderer?.hint ?? "", /ELECTRON_RUN_AS_NODE/u);
  assert.equal(manager.status().main.error?.hint, main?.hint, "status keeps the hint");
  await manager.close();
});

test("a port that answers with something other than a debugger is called out", async (t) => {
  const http = createServer((_request, response) => response.end("<html>dev server</html>"));
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => http.close(() => resolve())));
  const manager = new SessionManager(config());
  const result = await manager.attach({ rendererUrl: `http://127.0.0.1:${(http.address() as { port: number }).port}` });
  assert.ok(result.ok);
  assert.equal(result.data.errors[0]?.code, "PROTOCOL_ERROR");
  assert.match(result.data.errors[0]?.hint ?? "", /不是调试端口/u);
  await manager.close();
});

test("swapped ports: a renderer port given as mainUrl is rejected instead of evaluating in a page", async () => {
  const renderer = await startMock([page("window")]);
  const manager = new SessionManager(config());
  try {
    const result = await manager.attach({ mainUrl: renderer.endpoint });
    assert.ok(result.ok);
    assert.equal(result.data.main.online, false);
    assert.equal(result.data.errors[0]?.code, "MAIN_INSPECTOR_UNAVAILABLE");
    assert.match(result.data.errors[0]?.hint ?? "", /传反/u);
  } finally {
    await manager.close();
    await renderer.close();
  }
});

test("swapped ports: the main inspector given as rendererUrl is called out", async () => {
  const main = await startMock([{ id: "main", type: "node", title: "main", url: "" }]);
  const manager = new SessionManager(config());
  try {
    const result = await manager.attach({ rendererUrl: main.endpoint });
    assert.ok(result.ok);
    assert.equal(result.data.errors[0]?.code, "RENDERER_CDP_UNAVAILABLE");
    assert.match(result.data.errors[0]?.hint ?? "", /传反/u);
  } finally {
    await manager.close();
    await main.close();
  }
});

test("a renderer port that is a browser, not Electron, attaches with a warning", async () => {
  const chrome = await startMock([page("tab", "New Tab", "chrome://newtab/")], {
    userAgent: "Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 Chrome/150.0.0.0 Safari/537.36",
  });
  const electron = await startMock([page("window")], {
    userAgent: "Mozilla/5.0 AppleWebKit/537.36 app/1.0.0 Chrome/150.0.0.0 Electron/43.8.12 Safari/537.36",
  });
  const manager = new SessionManager(config());
  try {
    const wrong = await manager.attach({ rendererUrl: chrome.endpoint });
    assert.ok(wrong.ok);
    assert.equal(wrong.data.renderer.online, true);
    assert.equal(wrong.data.warnings[0]?.code, "RENDERER_NOT_ELECTRON");
    const right = await manager.attach({ rendererUrl: electron.endpoint });
    assert.ok(right.ok);
    assert.deepEqual(right.data.warnings, []);
  } finally {
    await manager.close();
    await Promise.all([chrome.close(), electron.close()]);
  }
});

test("a recreated window is reported when it replaces the page that was being inspected", async () => {
  const renderer = await startMock([page("first", "Main window")]);
  const manager = new SessionManager(config());
  try {
    const attached = await manager.attach({ rendererUrl: renderer.endpoint });
    assert.ok(attached.ok);
    assert.equal(attached.data.selectedTarget?.id, "first");

    renderer.setTargets([page("second", "Main window")]);
    renderer.dropSockets();
    await until(() => !manager.status().renderer.online, "renderer offline");
    const disconnected = await manager.inspector.evaluate({ scope: "renderer", expression: "1" });
    assert.ok(!disconnected.ok);
    assert.equal(disconnected.error.code, "SESSION_DISCONNECTED");
    assert.match(disconnected.error.hint ?? "", /electron_targets/u);

    const refreshed = await manager.refreshTargets({});
    assert.ok(refreshed.ok);
    assert.equal(refreshed.data.selectedTarget?.id, "second");
    const warning = refreshed.data.warnings[0];
    assert.equal(warning?.code, "TARGET_CHANGED");
    assert.deepEqual((warning?.details?.previous as { id: string }).id, "first");

    // An intended switch says so with clearSelection and gets no warning; neither does staying on the same page.
    const again = await manager.refreshTargets({});
    assert.ok(again.ok);
    assert.equal(again.data.selectedTarget?.id, "second");
    assert.deepEqual(again.data.warnings, []);
    renderer.setTargets([page("third")]);
    renderer.dropSockets();
    await until(() => !manager.status().renderer.online, "renderer offline again");
    const cleared = await manager.refreshTargets({ clearSelection: true });
    assert.ok(cleared.ok);
    assert.equal(cleared.data.selectedTarget?.id, "third");
    assert.deepEqual(cleared.data.warnings, []);
  } finally {
    await manager.close();
    await renderer.close();
  }
});

test("webview guests are listed and selectable but never chosen automatically", async () => {
  const renderer = await startMock([
    { id: "guest", type: "webview", title: "inner", url: "https://example.test/" },
    page("window", "Host"),
  ]);
  const manager = new SessionManager(config());
  try {
    const attached = await manager.attach({ rendererUrl: renderer.endpoint });
    assert.ok(attached.ok);
    assert.equal(attached.data.selectedTarget?.id, "window", "one window and one webview is not an ambiguity");
    assert.deepEqual(attached.data.targets.map((target) => target.type).sort(), ["page", "webview"]);
    const guest = await manager.refreshTargets({ targetId: "guest" });
    assert.ok(guest.ok);
    assert.equal(guest.data.selectedTarget?.id, "guest");

    renderer.setTargets([{ id: "guest", type: "webview", title: "inner", url: "https://example.test/" }]);
    const onlyGuest = await manager.refreshTargets({ clearSelection: true });
    assert.ok(onlyGuest.ok);
    assert.equal(onlyGuest.data.errors[0]?.code, "TARGET_NOT_FOUND");
    assert.match(onlyGuest.data.errors[0]?.hint ?? "", /webview/u);
  } finally {
    await manager.close();
    await renderer.close();
  }
});

test("several windows: the ambiguity error says how to choose", async () => {
  const renderer = await startMock([page("a", "Settings"), page("b", "Main")]);
  const manager = new SessionManager(config());
  try {
    const attached = await manager.attach({ rendererUrl: renderer.endpoint });
    assert.ok(attached.ok);
    assert.equal(attached.data.errors[0]?.code, "TARGET_SELECTION_REQUIRED");
    assert.match(attached.data.errors[0]?.hint ?? "", /title 和 url/u);
  } finally {
    await manager.close();
    await renderer.close();
  }
});

test("a JavaScript dialog is reported in status and explains the timeouts it causes", async () => {
  let blocked = false;
  const renderer = await startMock([page("window")], {
    respond: (method) => (blocked && method === "Runtime.evaluate" ? "hang" : {}),
  });
  const manager = new SessionManager(config());
  try {
    const attached = await manager.attach({ rendererUrl: renderer.endpoint });
    assert.ok(attached.ok && attached.data.renderer.online);
    blocked = true;
    renderer.push("Page.javascriptDialogOpening", { type: "confirm", message: "Delete? token=abc123secret" });
    await until(() => manager.status().dialogs !== undefined, "dialog reported");
    const [dialog] = manager.status().dialogs ?? [];
    assert.equal(dialog?.kind, "javascript");
    assert.equal(dialog?.type, "confirm");
    assert.equal(dialog?.blocking, true);
    assert.doesNotMatch(dialog?.message ?? "", /abc123secret/u, "dialog text is redacted");
    assert.ok(manager.status().renderer.dialogs?.length === 1);

    const evaluated = await manager.inspector.evaluate({ scope: "renderer", expression: "1", timeoutMs: 200 });
    assert.ok(!evaluated.ok);
    assert.match(evaluated.error.hint ?? "", /对话框/u);
    const logs = manager.logs({ process: "renderer" }).events.filter((event) => event.kind === "dialog");
    assert.equal(logs.length, 1);

    blocked = false;
    renderer.push("Page.javascriptDialogClosed", { result: true });
    await until(() => manager.status().dialogs === undefined, "dialog cleared");
    assert.equal(manager.logs({ process: "renderer" }).events.filter((event) => event.kind === "dialog").length, 2);

    // A crash takes the dialog with it and no Closed event follows.
    renderer.push("Page.javascriptDialogOpening", { type: "alert", message: "before crash" });
    await until(() => manager.status().dialogs !== undefined, "second dialog reported");
    renderer.push("Inspector.targetCrashed", {});
    await until(() => manager.status().dialogs === undefined, "dialog cleared by the crash");
    assert.ok(manager.logs({ process: "renderer" }).events.some((event) => event.message.endsWith("closed (the page crashed)")));
  } finally {
    await manager.close();
    await renderer.close();
  }
});

test("native dialogs are instrumented through the main process only when evaluation is allowed", async () => {
  const seen: string[] = [];
  const main = await startMock([{ id: "main", type: "node", title: "main", url: "" }], {
    respond: (method, params) => {
      seen.push(method === "Runtime.evaluate" ? `evaluate:${String(params.expression).includes("dialog") ? "dialogs" : "other"}` : method);
      return method === "Runtime.evaluate"
        ? { result: { type: "string", value: JSON.stringify({ installed: true, open: [] }) } }
        : {};
    },
  });
  const allowed = new SessionManager(config());
  const denied = new SessionManager(config({ allowEval: false }));
  try {
    assert.ok((await allowed.attach({ mainUrl: main.endpoint })).ok);
    assert.ok(seen.includes("Runtime.addBinding") && seen.includes("evaluate:dialogs"));
    main.push("Runtime.bindingCalled", {
      name: "__electronAgentDebugDialog",
      payload: JSON.stringify({ event: "open", id: 1, type: "showMessageBoxSync", blocking: true, title: "Quit?" }),
    });
    await until(() => allowed.status().dialogs !== undefined, "native dialog reported");
    assert.equal(allowed.status().dialogs?.[0]?.kind, "native");
    assert.equal(allowed.status().main.dialogs?.[0]?.type, "showMessageBoxSync");
    main.push("Runtime.bindingCalled", { name: "__electronAgentDebugDialog", payload: JSON.stringify({ event: "close", id: 1 }) });
    await until(() => allowed.status().dialogs === undefined, "native dialog cleared");

    seen.length = 0;
    assert.ok((await denied.attach({ mainUrl: main.endpoint })).ok);
    assert.equal(seen.includes("Runtime.addBinding"), false, "no app code runs when evaluation is disabled");
  } finally {
    await Promise.all([allowed.close(), denied.close()]);
    await main.close();
  }
});

test("dialog tracker ignores malformed notices and truncates long text", () => {
  const tracker = new DialogTracker("main");
  assert.equal(tracker.native("not json"), undefined);
  assert.equal(tracker.native(JSON.stringify({ event: "close", id: 9 })), undefined);
  const opened = tracker.native(JSON.stringify({ event: "open", id: 2, type: "showOpenDialog", blocking: false, message: "x".repeat(500) }));
  assert.equal(opened?.dialog.message?.length, 201);
  assert.equal(tracker.blocking, undefined, "an async dialog does not block the process");
});

test("screenshots are taken at CSS size on high-DPI screens and can be shrunk further", async (t) => {
  const clips: unknown[] = [];
  const png = (width: number, height: number) => {
    const header = Buffer.alloc(24);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(header);
    header.writeUInt32BE(width, 16);
    header.writeUInt32BE(height, 20);
    return header.toString("base64");
  };
  const renderer = await startMock([page("window")], {
    respond: (method, params) => {
      if (method === "Page.getLayoutMetrics") {
        return {
          cssVisualViewport: { pageX: 0, pageY: 0, clientWidth: 800, clientHeight: 600 },
          visualViewport: { pageX: 0, pageY: 0, clientWidth: 1600, clientHeight: 1200 },
        };
      }
      if (method === "Page.captureScreenshot") {
        clips.push(params.clip);
        const clip = params.clip as { width: number; height: number; scale: number } | undefined;
        return { data: clip ? png(clip.width * clip.scale * 2, clip.height * clip.scale * 2) : png(1600, 1200) };
      }
      return {};
    },
  });
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const path = await import("node:path");
  const outputDir = await mkdtemp(path.join(tmpdir(), "screenshot-scale-"));
  t.after(() => rm(outputDir, { recursive: true, force: true }));
  const manager = new SessionManager(config({ outputDir }));
  try {
    assert.ok((await manager.attach({ rendererUrl: renderer.endpoint })).ok);
    const css = await manager.inspector.screenshot({});
    assert.ok(css.ok);
    assert.deepEqual([css.data.width, css.data.height, css.data.deviceScaleFactor], [800, 600, 2]);
    assert.deepEqual(clips.at(-1), { x: 0, y: 0, width: 800, height: 600, scale: 0.5 });

    const small = await manager.inspector.screenshot({ maxWidth: 400 });
    assert.ok(small.ok);
    assert.deepEqual([small.data.width, small.data.height], [400, 300]);
    assert.equal((clips.at(-1) as { scale: number }).scale, 0.25);

    const full = await manager.inspector.screenshot({ maxWidth: 4_000 });
    assert.ok(full.ok);
    assert.deepEqual([full.data.width, full.data.height], [1600, 1200]);
    assert.equal(clips.at(-1), undefined, "full device resolution needs no clip");
  } finally {
    await manager.close();
    await renderer.close();
  }
});

test("the native dialog instrumentation is valid JavaScript", async () => {
  const { instrumentDialogsScript } = await import("../src/dialogs.js");
  assert.doesNotThrow(() => new Function(`return ${instrumentDialogsScript}`));
});
