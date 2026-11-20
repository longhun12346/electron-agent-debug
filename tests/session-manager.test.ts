import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import test from "node:test";
import { WebSocketServer, type WebSocket } from "ws";
import { SessionManager } from "../src/sessions/session-manager.js";
import type { RuntimeConfig } from "../src/config.js";
import type { AttachInput, TargetInfo } from "../src/types.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

interface MockDebugger {
  endpoint: string;
  broadcast(message: unknown): void;
  setTargets(
    targets: Array<Pick<TargetInfo, "id" | "type" | "title" | "url"> & {
      webSocketDebuggerUrl?: string | null;
    }>,
  ): void;
  close(): Promise<void>;
}

interface MockDebuggerOptions {
  discoveryDelayMs?: number;
  beforeDiscovery?: () => Promise<void>;
  closeOnMethod?: string;
  rejectMethod?: string;
}

async function startMockDebugger(
  targets: Array<Pick<TargetInfo, "id" | "type" | "title" | "url"> & {
    webSocketDebuggerUrl?: string | null;
  }>,
  options: MockDebuggerOptions = {},
): Promise<MockDebugger> {
  const httpServer = createServer();
  const wsServer = new WebSocketServer({ server: httpServer });
  const sockets = new Set<WebSocket>();
  let currentTargets = targets;

  wsServer.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("message", (raw) => {
      const message = JSON.parse(raw.toString()) as { id?: number; method?: string };
      if (message.method === options.closeOnMethod) {
        socket.close(1000, "closed during domain setup");
        return;
      }
      if (message.id !== undefined) {
        socket.send(JSON.stringify(message.method === options.rejectMethod
          ? { id: message.id, error: { code: -32601, message: "unsupported method" } }
          : { id: message.id, result: { ok: true } }));
      }
    });
  });

  await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  const address = httpServer.address();
  assert.ok(address && typeof address === "object");
  const port = address.port;
  const endpoint = `http://127.0.0.1:${port}`;

  httpServer.on("request", (request, response) => {
    if (request.url !== "/json/list") {
      response.writeHead(404).end();
      return;
    }
    const writeDiscovery = () => {
      const body = currentTargets.map((target) => ({
        ...target,
        webSocketDebuggerUrl:
          target.webSocketDebuggerUrl === null
            ? undefined
            : target.webSocketDebuggerUrl ??
              `ws://127.0.0.1:${port}/devtools/page/${target.id}`,
      }));
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(body));
    };
    if (options.beforeDiscovery) {
      void options.beforeDiscovery().then(writeDiscovery);
    } else if (options.discoveryDelayMs) {
      setTimeout(writeDiscovery, options.discoveryDelayMs);
    } else {
      writeDiscovery();
    }
  });

  return {
    endpoint,
    broadcast(message) {
      const raw = JSON.stringify(message);
      for (const socket of sockets) {
        socket.send(raw);
      }
    },
    setTargets(nextTargets) {
      currentTargets = nextTargets;
    },
    async close() {
      for (const socket of sockets) {
        socket.close();
      }
      await new Promise<void>((resolve) => wsServer.close(() => resolve()));
      await new Promise<void>((resolve) => (httpServer as Server).close(() => resolve()));
    },
  };
}

function runtimeConfig(mainUrl?: string, rendererUrl?: string): RuntimeConfig {
  return {
    mainUrl,
    rendererUrl,
    requestTimeoutMs: 1_000,
    discoveryTimeoutMs: 1_000,
    maxLogEvents: 100,
    maxLogBytes: 100_000,
    maxProtocolMessageBytes: 100_000,
  };
}

for (const scope of ["main", "renderer", "all", undefined] as const) {
  test(`filters manager logs for ${scope ?? "default"} before applying limit`, () => {
    const manager = new SessionManager(runtimeConfig());
    for (const [process, message, observedAt, level] of [
      ["main", "old-main", "2026-01-01T00:00:00.000Z", "error"],
      ["main", "new-main", "2026-01-01T00:00:01.000Z", "error"],
      ["renderer", "renderer-error", "2026-01-01T00:00:02.000Z", "error"],
      ["renderer", "renderer-log", "2026-01-01T00:00:03.000Z", "log"],
    ] as const) {
      manager[process].events.add({ process, message, observedAt, level, kind: "console" });
    }
    const events = manager.logs({
      process: scope,
      level: "error",
      since: "2026-01-01T00:00:01.000Z",
      limit: 1,
    }).events;
    assert.deepEqual(events.map((event) => event.message),
      scope === "main" ? ["new-main"] : ["renderer-error"]);
  });

  test(`clears only requested log scope ${scope ?? "default"}`, () => {
    const manager = new SessionManager(runtimeConfig());
    for (const process of ["main", "renderer"] as const) {
      manager[process].events.add({
        process, message: process, observedAt: "2026-01-01T00:00:00.000Z",
        level: "log", kind: "console",
      });
    }
    const result = manager.logs({ process: scope, clear: true });
    assert.equal(result.cleared, true);
    assert.deepEqual(result.events.map((event) => event.process),
      scope && scope !== "all" ? [scope] : ["main", "renderer"]);
    assert.equal(manager.main.events.size, scope === "renderer" ? 1 : 0);
    assert.equal(manager.renderer.events.size, scope === "main" ? 1 : 0);
  });
}

test("reports evicted events through droppedThroughSeq and gap, scoped to the requested process", () => {
  const manager = new SessionManager({ ...runtimeConfig(), maxLogEvents: 2 });
  const add = (process: "main" | "renderer", message: string) =>
    manager[process].events.add({ process, message, observedAt: "2026-01-01T00:00:00.000Z", level: "log", kind: "console" });
  add("main", "m1");
  add("main", "m2");
  add("main", "m3");
  add("renderer", "r4");

  const all = manager.logs({});
  assert.equal(all.lastSeq, 4);
  assert.equal(all.droppedThroughSeq, 1, "m1 (seq 1) was evicted");
  assert.equal(all.gap, true);
  assert.equal(manager.logs({ afterSeq: 1 }).gap, false, "nothing after seq 1 was lost");
  assert.equal(manager.logs({ afterSeq: 0 }).gap, true);
  assert.equal(manager.logs({ process: "renderer" }).droppedThroughSeq, 0, "renderer buffer never overflowed");
  assert.equal(manager.logs({ process: "renderer" }).gap, false);

  manager.logs({ process: "main", clear: true });
  assert.equal(manager.logs({}).gap, false, "events the caller cleared are not reported as lost");
});

test("sinceAttach leaves out the history replayed before each channel's latest connection", () => {
  const manager = new SessionManager(runtimeConfig());
  const add = (process: "main" | "renderer", kind: "console" | "connection", message: string) =>
    manager[process].events.add({ process, kind, message, observedAt: "2026-01-01T00:00:00.000Z", level: "log" });
  const messages = (input: Parameters<SessionManager["logs"]>[0]) =>
    manager.logs(input).events.map((event) => event.message);

  add("main", "console", "replayed-main");
  add("main", "connection", "Session connected");
  add("main", "console", "fresh-main");
  add("renderer", "console", "renderer-never-connected");

  assert.deepEqual(messages({ sinceAttach: true }), ["fresh-main", "renderer-never-connected"]);
  assert.deepEqual(messages({}), ["replayed-main", "Session connected", "fresh-main", "renderer-never-connected"]);

  add("main", "connection", "Session connected");
  add("main", "console", "after-reconnect");
  assert.deepEqual(messages({ process: "main", sinceAttach: true }), ["after-reconnect"]);

  const { lastSeq } = manager.logs({});
  add("main", "console", "newest");
  assert.deepEqual(messages({ process: "main", sinceAttach: true, afterSeq: lastSeq }), ["newest"]);
  assert.deepEqual(messages({ process: "main", sinceAttach: true, afterSeq: 0 }), ["after-reconnect", "newest"],
    "a smaller afterSeq cannot move the boundary back before the connection");
});

test("sinceAttach does not report a gap for events evicted before the connection", () => {
  const manager = new SessionManager({ ...runtimeConfig(), maxLogEvents: 3 });
  const add = (kind: "console" | "connection", message: string) =>
    manager.main.events.add({ process: "main", kind, message, observedAt: "2026-01-01T00:00:00.000Z", level: "log" });
  add("console", "old-1");
  add("console", "old-2");
  add("connection", "Session connected");
  add("console", "fresh");

  assert.equal(manager.logs({}).gap, true, "the full history lost events");
  const since = manager.logs({ sinceAttach: true });
  assert.equal(since.gap, false, "nothing was lost after the connection");
  assert.deepEqual(since.events.map((event) => event.message), ["fresh"]);

  add("console", "fresh-2");
  add("console", "fresh-3");
  assert.equal(manager.logs({ sinceAttach: true }).gap, false,
    "the connection event itself was evicted, but nothing observed after it was");
  add("console", "fresh-4");
  assert.equal(manager.logs({ sinceAttach: true }).gap, true,
    "now an event observed after the connection was evicted, which the caller must be told about");
  assert.deepEqual(manager.logs({ sinceAttach: true }).events.map((event) => event.message),
    ["fresh-2", "fresh-3", "fresh-4"]);
});

test("a crashed renderer is reported offline with TARGET_CRASHED until the page reloads", async () => {
  const renderer = await startMockDebugger([{ id: "window-a", type: "page", title: "Window A", url: "app://a" }]);
  const manager = new SessionManager(runtimeConfig());
  const settle = () => new Promise((resolve) => setTimeout(resolve, 30));
  try {
    await manager.attach({ rendererUrl: renderer.endpoint });
    assert.equal(manager.status().renderer.online, true);
    const { lastSeq } = manager.logs({});

    // Chromium keeps the connection open after a crash, so nothing else tells the caller the page is gone.
    renderer.broadcast({ method: "Inspector.targetCrashed", params: {} });
    await settle();
    const crashed = manager.status().renderer;
    assert.equal(crashed.online, false);
    assert.equal(crashed.status, "offline");
    assert.equal(crashed.error?.code, "TARGET_CRASHED");
    assert.equal(crashed.error?.retryable, true);
    await assert.rejects(
      () => manager.renderer.request("Runtime.evaluate", { expression: "1" }, 5_000),
      (error: unknown) => error instanceof Error && "diagnostic" in error &&
        (error as { diagnostic: { code: string } }).diagnostic.code === "TARGET_CRASHED",
    );
    const crashEvent = manager.logs({ afterSeq: lastSeq }).events.find((event) => event.kind === "exception");
    assert.match(crashEvent?.message ?? "", /^Target crashed/u);
    assert.equal(crashEvent?.level, "error");
    assert.equal(crashEvent?.process, "renderer");

    // The same connection and target recover when the page is reloaded.
    renderer.broadcast({ method: "Inspector.targetReloadedAfterCrash", params: {} });
    await settle();
    const recovered = manager.status().renderer;
    assert.equal(recovered.online, true);
    assert.equal(recovered.error, undefined);
    await manager.renderer.request("Runtime.evaluate", { expression: "1" });
    assert.ok(manager.logs({ afterSeq: lastSeq }).events.some((event) => event.message === "Target reloaded after crash"));
  } finally {
    await manager.close();
    await renderer.close();
  }
});

test("a new connection starts without the previous crash, and Inspector.enable is optional", async () => {
  const renderer = await startMockDebugger(
    [{ id: "window-a", type: "page", title: "Window A", url: "app://a" }],
    { rejectMethod: "Inspector.enable" },
  );
  const manager = new SessionManager(runtimeConfig());
  try {
    await manager.attach({ rendererUrl: renderer.endpoint });
    assert.equal(manager.status().renderer.online, true, "an unsupported Inspector domain must not block the session");
    assert.ok(manager.logs({}).events.some((event) => event.kind === "protocol" && /Inspector\.enable/u.test(event.message)));

    renderer.broadcast({ method: "Inspector.targetCrashed", params: {} });
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(manager.status().renderer.online, false);

    await manager.renderer.close("test reconnect");
    await manager.attach({ rendererUrl: renderer.endpoint, clearSelection: true });
    assert.equal(manager.status().renderer.online, true, "a fresh connection is not crashed");
  } finally {
    await manager.close();
    await renderer.close();
  }
});

test("status reports the current lastSeq so a baseline can be taken without reading logs", () => {
  const manager = new SessionManager(runtimeConfig());
  assert.equal(manager.status().lastSeq, 0);
  manager.main.events.add({
    process: "main", message: "one", observedAt: "2026-01-01T00:00:00.000Z", level: "log", kind: "console",
  });
  assert.equal(manager.status().lastSeq, 1);
  assert.equal(manager.status().lastSeq, manager.logs({}).lastSeq);
});

for (const failingProcess of ["main", "renderer"] as const) {
  test(`does not report ${failingProcess} online after disconnect during domain setup`, async () => {
    const main = await startMockDebugger(
      [{ id: "main", type: "node", title: "Main", url: "" }],
      failingProcess === "main" ? { closeOnMethod: "Runtime.enable" } : {},
    );
    const renderer = await startMockDebugger(
      [{ id: "window-a", type: "page", title: "A", url: "app://a" }],
      failingProcess === "renderer" ? { closeOnMethod: "Runtime.enable" } : {},
    );
    const manager = new SessionManager(runtimeConfig());
    try {
      const attached = await manager.attach({ mainUrl: main.endpoint, rendererUrl: renderer.endpoint });
      assert.equal(attached.ok, true);
      if (!attached.ok) return;
      assert.equal(attached.data[failingProcess].online, false);
      assert.equal(attached.data[failingProcess].status, "offline");
      assert.equal(manager[failingProcess].isConnected, false);
      assert.ok(attached.data.errors.length > 0);
      const otherProcess = failingProcess === "main" ? "renderer" : "main";
      assert.equal(attached.data[otherProcess].online, true);
    } finally {
      await manager.close();
      await Promise.all([main.close(), renderer.close()]);
    }
  });
}

test("renderer disconnect during Log.enable cannot report online", async () => {
  const renderer = await startMockDebugger(
    [{ id: "window-a", type: "page", title: "A", url: "app://a" }],
    { closeOnMethod: "Log.enable" },
  );
  const manager = new SessionManager(runtimeConfig());
  try {
    const result = await manager.attach({ rendererUrl: renderer.endpoint });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.data.renderer.status, "offline");
    assert.equal(result.data.renderer.online, false);
    assert.equal(result.data.selectedTarget, undefined);
    assert.ok(result.data.errors.length > 0);
  } finally {
    await manager.close();
    await renderer.close();
  }
});

test("unsupported optional renderer domain records a warning and preserves live Runtime", async () => {
  const renderer = await startMockDebugger(
    [{ id: "window-a", type: "page", title: "A", url: "app://a" }],
    { rejectMethod: "Log.enable" },
  );
  const manager = new SessionManager(runtimeConfig());
  try {
    const result = await manager.attach({ rendererUrl: renderer.endpoint });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.data.renderer.online, true);
    assert.equal(manager.renderer.isConnected, true);
    assert.ok(manager.logs({ process: "renderer" }).events.some((event) =>
      event.kind === "protocol" && event.level === "warn" && event.message.includes("Log.enable")));
  } finally {
    await manager.close();
    await renderer.close();
  }
});

test("invalid log timestamp cannot clear existing evidence", () => {
  const manager = new SessionManager(runtimeConfig());
  manager.main.events.add({
    process: "main", observedAt: "2026-01-01T00:00:00.000Z",
    kind: "console", message: "retained",
  });
  assert.throws(() => manager.logs({ since: "invalid", clear: true }), /since/u);
  assert.equal(manager.main.events.size, 1);
});

test("renders exceptions and traces as readable text with compact, redacted data", async () => {
  const renderer = await startMockDebugger([
    { id: "window-a", type: "page", title: "Window A", url: "app://a" },
  ]);
  const manager = new SessionManager(runtimeConfig());
  const frame = (functionName: string, lineNumber: number) =>
    ({ functionName, scriptId: "7", url: "app://a/app.js", lineNumber, columnNumber: 4 });
  try {
    await manager.attach({ rendererUrl: renderer.endpoint });
    const { lastSeq } = manager.logs({});
    for (const message of [
      {
        method: "Runtime.exceptionThrown",
        params: { exceptionDetails: {
          exceptionId: 1, text: "Uncaught", lineNumber: 9, columnNumber: 10, scriptId: "7", url: "app://a/app.js",
          stackTrace: { callFrames: [frame("save", 9)] },
          exception: {
            type: "object", subtype: "error", className: "Error", objectId: "1",
            description: "Error: save failed password=hunter2hunter2\n    at save (app://a/app.js:10:11)",
            preview: { description: "Error: save failed password=hunter2hunter2" },
          },
        } },
      },
      {
        // A thrown non-Error value has no stack in its description; the frames come from stackTrace.
        method: "Runtime.exceptionThrown",
        params: { exceptionDetails: {
          text: "Uncaught (in promise)", lineNumber: 2, columnNumber: 0, url: "app://a/app.js",
          stackTrace: { callFrames: [frame("load", 2), frame("", 30)] },
          exception: { type: "string", value: "plain rejection" },
        } },
      },
      { method: "Runtime.exceptionThrown", params: { exceptionDetails: { text: "Script error." } } },
      {
        method: "Runtime.consoleAPICalled",
        params: {
          type: "trace", args: [{ type: "string", value: "checkpoint" }],
          stackTrace: { callFrames: Array.from({ length: 14 }, (_, index) => frame(`step${index}`, index)) },
        },
      },
      {
        method: "Runtime.consoleAPICalled",
        params: {
          type: "log", args: [{ type: "string", value: "plain" }],
          stackTrace: { callFrames: [frame("noisy", 1)] },
        },
      },
      {
        method: "Log.entryAdded",
        params: { entry: {
          source: "network", level: "error", text: "Failed to load token=abcdef123456", timestamp: 1,
          url: "https://example.test/api", lineNumber: 0, networkRequestId: "55.1",
          stackTrace: { callFrames: [frame("fetchData", 5)] },
        } },
      },
    ]) {
      renderer.broadcast(message);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));

    const events = manager.logs({ afterSeq: lastSeq }).events;
    assert.equal(JSON.stringify(events).includes("hunter2hunter2"), false);
    assert.equal(JSON.stringify(events).includes("abcdef123456"), false);
    assert.deepEqual(events.map((event) => [event.kind, event.level, event.message, event.data]), [
      ["exception", "error",
        "Uncaught Error: save failed password=[REDACTED]\n    at save (app://a/app.js:10:11)",
        { url: "app://a/app.js", line: 10, column: 11 }],
      ["exception", "error",
        "Uncaught (in promise) plain rejection\n    at load (app://a/app.js:3:5)\n    at <anonymous> (app://a/app.js:31:5)",
        { url: "app://a/app.js", line: 3, column: 1 }],
      ["exception", "error", "Script error.", undefined],
      ["console", "trace",
        ["checkpoint", ...Array.from({ length: 10 }, (_, index) => `    at step${index} (app://a/app.js:${index + 1}:5)`),
          "    … 4 more frames"].join("\n"),
        { type: "trace" }],
      ["console", "log", "plain", { type: "log" }],
      ["console", "error", "Failed to load token=[REDACTED]",
        { source: "network", url: "https://example.test/api" }],
    ]);
  } finally {
    await manager.close();
    await renderer.close();
  }
});

test("attaches both sessions, selects a page, and collects events", async () => {
  const main = await startMockDebugger([{ id: "main", type: "node", title: "main", url: "" }]);
  const renderer = await startMockDebugger([
    { id: "window-a", type: "page", title: "Window A", url: "app://a" },
  ]);
  const manager = new SessionManager(runtimeConfig());

  try {
    const result = await manager.attach({
      mainUrl: main.endpoint,
      rendererUrl: renderer.endpoint,
    });

    assert.equal(result.ok, true);
    if (!result.ok) {
      return;
    }
    assert.equal(result.data.main.status, "online");
    assert.equal(result.data.renderer.status, "online");
    assert.equal(result.data.selectedTarget?.id, "window-a");

    renderer.broadcast({
      method: "Runtime.consoleAPICalled",
      params: { type: "log", args: [{ value: "renderer-ready" }] },
    });
    main.broadcast({
      method: "Runtime.exceptionThrown",
      params: { exceptionDetails: { text: "main-failure" } },
    });
    await new Promise((resolve) => setTimeout(resolve, 10));

    const logs = manager.logs({ process: "all", limit: 20 }).events;
    assert.ok(
      logs.some((event) => event.process === "renderer" && event.message === "renderer-ready"),
    );
    assert.ok(logs.some((event) => event.process === "main" && event.kind === "exception"));
  } finally {
    await Promise.all([main.close(), renderer.close()]);
  }
});

test("keeps an idempotently reattached session online", async () => {
  const main = await startMockDebugger([{ id: "main", type: "node", title: "main", url: "" }]);
  const renderer = await startMockDebugger([
    { id: "window-a", type: "page", title: "Window A", url: "app://a" },
  ]);
  const manager = new SessionManager(runtimeConfig());

  try {
    const first = await manager.attach({
      mainUrl: main.endpoint,
      rendererUrl: renderer.endpoint,
    });
    assert.equal(first.ok, true);

    const second = await manager.attach({
      mainUrl: main.endpoint,
      rendererUrl: renderer.endpoint,
    });
    assert.equal(second.ok, true);
    assert.equal(manager.status().main.status, "online");
    assert.equal(manager.status().renderer.status, "online");
  } finally {
    await Promise.all([main.close(), renderer.close()]);
  }
});

test("allows a renderer-only attach", async () => {
  const renderer = await startMockDebugger([
    { id: "window-a", type: "page", title: "Window A", url: "app://a" },
  ]);
  const manager = new SessionManager(runtimeConfig());

  try {
    const result = await manager.attach({ rendererUrl: renderer.endpoint });
    assert.equal(result.ok, true);
    if (!result.ok) {
      return;
    }
    assert.equal(result.data.main.status, "unconfigured");
    assert.equal(result.data.renderer.status, "online");
  } finally {
    await renderer.close();
  }
});

test("keeps the renderer result when the main endpoint is unavailable", async () => {
  const unavailableMain = await startMockDebugger([{ id: "main", type: "node", title: "main", url: "" }]);
  await unavailableMain.close();
  const renderer = await startMockDebugger([
    { id: "window-a", type: "page", title: "Window A", url: "app://a" },
  ]);
  const manager = new SessionManager(runtimeConfig());

  try {
    const result = await manager.attach({
      mainUrl: unavailableMain.endpoint,
      rendererUrl: renderer.endpoint,
    });
    assert.equal(result.ok, true);
    if (!result.ok) {
      return;
    }
    assert.equal(result.data.main.status, "offline");
    assert.equal(result.data.renderer.status, "online");
    assert.ok(result.data.errors.some((error) => error.code === "MAIN_INSPECTOR_UNAVAILABLE"));
  } finally {
    await renderer.close();
  }
});

test("preserves the other session when one endpoint input is invalid", async () => {
  const main = await startMockDebugger([{ id: "main", type: "node", title: "main", url: "" }]);
  const renderer = await startMockDebugger([
    { id: "window-a", type: "page", title: "Window A", url: "app://a" },
  ]);
  const manager = new SessionManager(runtimeConfig());

  try {
    const first = await manager.attach({
      mainUrl: main.endpoint,
      rendererUrl: renderer.endpoint,
    });
    assert.equal(first.ok, true);

    const second = await manager.attach({
      mainUrl: "not-a-url",
      rendererUrl: renderer.endpoint,
    });
    assert.equal(second.ok, true);
    if (!second.ok) {
      return;
    }
    assert.equal(second.data.main.status, "online");
    assert.equal(second.data.renderer.status, "online");
    assert.ok(second.data.errors.some((error) => error.code === "INVALID_ENDPOINT"));
  } finally {
    await Promise.all([main.close(), renderer.close()]);
  }
});

test("does not report a renderer session online when target selection is blocked", async () => {
  const renderer = await startMockDebugger([
    { id: "window-a", type: "page", title: "Window A", url: "app://a" },
    { id: "window-b", type: "page", title: "Window B", url: "app://b" },
  ]);
  const manager = new SessionManager(runtimeConfig());

  try {
    const result = await manager.attach({ rendererUrl: renderer.endpoint });
    assert.equal(result.ok, true);
    if (!result.ok) {
      return;
    }
    assert.equal(result.data.renderer.status, "offline");
    assert.equal(result.data.renderer.online, false);
    assert.equal(result.data.renderer.selectedTarget, undefined);
    assert.equal(result.data.renderer.error?.code, "TARGET_SELECTION_REQUIRED");
  } finally {
    await renderer.close();
  }
});

test("returns discovered page targets even when one cannot be attached", async () => {
  const renderer = await startMockDebugger([
    { id: "unavailable", type: "page", title: "Unavailable", url: "app://unavailable", webSocketDebuggerUrl: null },
    { id: "available", type: "page", title: "Available", url: "app://available" },
  ]);
  const manager = new SessionManager(runtimeConfig());

  try {
    const result = await manager.attach({ rendererUrl: renderer.endpoint });
    assert.equal(result.ok, true);
    if (!result.ok) {
      return;
    }
    assert.deepEqual(
      result.data.targets.map((target) => target.id),
      ["unavailable", "available"],
    );
    assert.equal(result.data.selectedTarget?.id, "available");
    assert.equal(result.data.renderer.status, "online");
  } finally {
    await renderer.close();
  }
});

test("does not attach to the only page target without a WebSocket address", async () => {
  const renderer = await startMockDebugger([
    { id: "unavailable", type: "page", title: "Unavailable", url: "app://unavailable", webSocketDebuggerUrl: null },
  ]);
  const manager = new SessionManager(runtimeConfig());

  try {
    const result = await manager.attach({ rendererUrl: renderer.endpoint });
    assert.equal(result.ok, true);
    if (!result.ok) {
      return;
    }
    assert.equal(result.data.targets.length, 1);
    assert.equal(result.data.targets[0]?.webSocketDebuggerUrl, undefined);
    assert.equal(result.data.renderer.status, "offline");
    assert.equal(result.data.renderer.error?.code, "TARGET_NOT_FOUND");
  } finally {
    await renderer.close();
  }
});

test("clears stale renderer evidence when discovery fails", async () => {
  const renderer = await startMockDebugger([
    { id: "window-a", type: "page", title: "Window A", url: "app://a" },
  ]);
  const manager = new SessionManager(runtimeConfig());
  let rendererClosed = false;

  try {
    const first = await manager.attach({ rendererUrl: renderer.endpoint });
    assert.equal(first.ok, true);
    await renderer.close();
    rendererClosed = true;

    const second = await manager.attach({ rendererUrl: renderer.endpoint });
    assert.equal(second.ok, true);
    if (!second.ok) {
      return;
    }
    assert.equal(second.data.targets.length, 0);
    assert.equal(second.data.renderer.selectedTarget, undefined);
    assert.equal(second.data.renderer.status, "offline");
    assert.equal(second.data.renderer.error?.code, "RENDERER_CDP_UNAVAILABLE");
  } finally {
    if (!rendererClosed) {
      await renderer.close();
    }
  }
});

test("automatically selects a replacement page when the old target disappears", async () => {
  const renderer = await startMockDebugger([
    { id: "window-old", type: "page", title: "Old", url: "app://old" },
  ]);
  const manager = new SessionManager(runtimeConfig());

  try {
    const first = await manager.attach({ rendererUrl: renderer.endpoint });
    assert.equal(first.ok, true);
    assert.equal(first.data.selectedTarget?.id, "window-old");

    renderer.setTargets([
      { id: "window-new", type: "page", title: "New", url: "app://new" },
    ]);
    const second = await manager.attach({ rendererUrl: renderer.endpoint });
    assert.equal(second.ok, true);
    if (!second.ok) {
      return;
    }
    assert.equal(second.data.selectedTarget?.id, "window-new");
    assert.equal(second.data.renderer.status, "online");
  } finally {
    await renderer.close();
  }
});

test("clears the selected target when the renderer session disconnects", async () => {
  const renderer = await startMockDebugger([
    { id: "window-a", type: "page", title: "Window A", url: "app://a" },
  ]);
  const manager = new SessionManager(runtimeConfig());

  try {
    const result = await manager.attach({ rendererUrl: renderer.endpoint });
    assert.equal(result.ok, true);
    assert.equal(manager.status().renderer.selectedTarget?.id, "window-a");

    await renderer.close();
    await new Promise((resolve) => setTimeout(resolve, 10));

    const status = manager.status();
    assert.equal(status.renderer.status, "offline");
    assert.equal(status.renderer.selectedTarget, undefined);
    assert.deepEqual(status.targets, []);
  } finally {
    await renderer.close();
  }
});

test("closes the old main session before switching endpoints", async () => {
  const main = await startMockDebugger([{ id: "main", type: "node", title: "main", url: "" }]);
  const unavailable = await startMockDebugger([{ id: "main", type: "node", title: "main", url: "" }]);
  const unavailableEndpoint = unavailable.endpoint;
  await unavailable.close();
  const renderer = await startMockDebugger([
    { id: "window-a", type: "page", title: "Window A", url: "app://a" },
  ]);
  const manager = new SessionManager(runtimeConfig());

  try {
    const first = await manager.attach({
      mainUrl: main.endpoint,
      rendererUrl: renderer.endpoint,
    });
    assert.equal(first.ok, true);
    assert.equal(manager.main.isConnected, true);

    const second = await manager.attach({
      mainUrl: unavailableEndpoint,
      rendererUrl: renderer.endpoint,
    });
    assert.equal(second.ok, true);
    if (!second.ok) {
      return;
    }
    assert.equal(manager.main.isConnected, false);
    assert.equal(manager.main.snapshot().status, "offline");
    assert.ok(
      second.data.errors.some((error) => error.code === "MAIN_INSPECTOR_UNAVAILABLE"),
    );
  } finally {
    await Promise.all([main.close(), renderer.close()]);
  }
});

test("serializes concurrent attach operations", async () => {
  const slow = await startMockDebugger(
    [{ id: "slow-window", type: "page", title: "Slow", url: "app://slow" }],
    { discoveryDelayMs: 50 },
  );
  const fast = await startMockDebugger([
    { id: "fast-window", type: "page", title: "Fast", url: "app://fast" },
  ]);
  const manager = new SessionManager(runtimeConfig());

  try {
    const first = manager.attach({ rendererUrl: slow.endpoint });
    const second = manager.attach({ rendererUrl: fast.endpoint });
    const [firstResult, secondResult] = await Promise.all([first, second]);

    assert.equal(firstResult.ok, true);
    assert.equal(secondResult.ok, true);
    assert.equal(manager.status().renderer.endpoint, fast.endpoint);
    assert.equal(manager.status().selectedTarget?.id, "fast-window");
  } finally {
    await Promise.all([slow.close(), fast.close()]);
  }
});

for (const order of ["targets-close-attach", "close-targets-attach"] as const) {
  test(`serializes gated attach with ${order} and preserves the final session`,
    { timeout: 10_000 }, async (t) => {
      const entered = deferred();
      const release = deferred();
      let discoveryCalls = 0;
      const renderer = await startMockDebugger([
        { id: "window-a", type: "page", title: "A", url: "app://a" },
        { id: "window-b", type: "page", title: "B", url: "app://b" },
      ], { beforeDiscovery: async () => {
        discoveryCalls++;
        if (discoveryCalls === 1) {
          entered.resolve();
          await release.promise;
        }
      } });
      const manager = new SessionManager(runtimeConfig());
      t.after(async () => {
        release.resolve();
        await manager.close();
        await renderer.close();
      });
      const first = manager.attach({ rendererUrl: renderer.endpoint, targetId: "window-a" });
      await entered.promise;
      const completed: string[] = [];
      const targets = () => manager.refreshTargets({
        rendererUrl: renderer.endpoint, targetId: "window-b",
      }).then((result) => {
        assert.equal(result.ok, true);
        if (result.ok) assert.equal(result.data.selectedTarget?.id, "window-b");
        completed.push("targets");
      });
      const close = () => manager.close().then(() => {
        assert.equal(manager.renderer.isConnected, false);
        assert.deepEqual(manager.status().targets, []);
        completed.push("close");
      });
      const middle = order.startsWith("targets") ? [targets(), close()] : [close(), targets()];
      const last = manager.attach({
        rendererUrl: renderer.endpoint, clearSelection: true, targetId: "window-a",
      }).then((result) => {
        assert.equal(result.ok, true);
        completed.push("attach");
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(discoveryCalls, 1, "queued discovery must not begin before release");
      assert.deepEqual(completed, []);
      release.resolve();
      await Promise.all([first, ...middle, last]);
      assert.deepEqual(completed, order.split("-"));
      assert.equal(manager.status().selectedTarget?.id, "window-a");
      assert.equal(manager.status().renderer.online, true);
    });
}

test("already queued targets and attach recover after a rejected close",
  { timeout: 10_000 }, async (t) => {
    const renderer = await startMockDebugger([
      { id: "window", type: "page", title: "A", url: "app://a" },
    ]);
    const manager = new SessionManager(runtimeConfig());
    const originalClose = manager.main.close.bind(manager.main);
    const entered = deferred();
    const release = deferred();
    t.after(async () => {
      release.resolve();
      manager.main.close = originalClose;
      await manager.close();
      await renderer.close();
    });
    await manager.attach({ rendererUrl: renderer.endpoint });
    manager.main.close = async () => {
      entered.resolve();
      await release.promise;
      manager.main.close = originalClose;
      throw new Error("queued close failure");
    };
    const rejected = assert.rejects(manager.close(), /queued close failure/u);
    await entered.promise;
    const targets = manager.refreshTargets({ rendererUrl: renderer.endpoint });
    const attach = manager.attach({ rendererUrl: renderer.endpoint });
    release.resolve();
    const [, refreshed, attached] = await Promise.all([rejected, targets, attach]);
    assert.equal(refreshed.ok, true);
    assert.equal(attached.ok, true);
    assert.equal(manager.status().renderer.online, true);
    assert.equal(manager.status().selectedTarget?.id, "window");
  });

test("recovers the operation queue after a failed operation", async () => {
  const first = await startMockDebugger([{ id: "first", type: "node", title: "first", url: "" }]);
  const second = await startMockDebugger([{ id: "second", type: "node", title: "second", url: "" }]);
  const manager = new SessionManager(runtimeConfig());
  const originalClose = manager.main.close.bind(manager.main);

  try {
    const initial = await manager.attach({ mainUrl: first.endpoint });
    assert.equal(initial.ok, true);

    manager.main.close = async () => {
      throw new Error("forced close failure");
    };
    await assert.rejects(
      () => manager.attach({ mainUrl: second.endpoint }),
      /forced close failure/,
    );

    manager.main.close = originalClose;
    const recovered = await manager.attach({ mainUrl: first.endpoint });
    assert.equal(recovered.ok, true);
    assert.equal(manager.status().main.endpoint, first.endpoint);
    assert.equal(manager.status().main.status, "online");
  } finally {
    manager.main.close = originalClose;
    await manager.close();
    await Promise.all([first.close(), second.close()]);
  }
});

test("closes both sessions and resets manager state", async () => {
  const main = await startMockDebugger([{ id: "main", type: "node", title: "main", url: "" }]);
  const renderer = await startMockDebugger([
    { id: "window-a", type: "page", title: "Window A", url: "app://a" },
  ]);
  const manager = new SessionManager(runtimeConfig());

  try {
    const attached = await manager.attach({
      mainUrl: main.endpoint,
      rendererUrl: renderer.endpoint,
    });
    assert.equal(attached.ok, true);
    assert.equal(manager.main.isConnected, true);
    assert.equal(manager.renderer.isConnected, true);

    await manager.close();
    await manager.close();

    const status = manager.status();
    assert.equal(manager.main.isConnected, false);
    assert.equal(manager.renderer.isConnected, false);
    assert.equal(status.main.status, "unconfigured");
    assert.equal(status.renderer.status, "unconfigured");
    assert.equal(status.main.endpoint, undefined);
    assert.equal(status.renderer.endpoint, undefined);
    assert.equal(status.targets.length, 0);
    assert.equal(status.selectedTarget, undefined);
  } finally {
    await Promise.all([main.close(), renderer.close()]);
  }
});

test("returns a selection error when multiple page targets exist", async () => {
  const renderer = await startMockDebugger([
    { id: "window-a", type: "page", title: "Window A", url: "app://a" },
    { id: "window-b", type: "page", title: "Window B", url: "app://b" },
  ]);
  const manager = new SessionManager(runtimeConfig());

  try {
    const result = await manager.attach({ rendererUrl: renderer.endpoint });
    assert.equal(result.ok, true);
    if (!result.ok) {
      return;
    }
    assert.ok(result.data.errors.some((error) => error.code === "TARGET_SELECTION_REQUIRED"));
    assert.equal(result.data.selectedTarget, undefined);
  } finally {
    await renderer.close();
  }
});

test("clears a stale target selector when requested", async () => {
  const renderer = await startMockDebugger([
    { id: "window-a", type: "page", title: "Window A", url: "app://a" },
    { id: "window-b", type: "page", title: "Window B", url: "app://b" },
  ]);
  const manager = new SessionManager(runtimeConfig());

  try {
    const selected = await manager.attach({
      rendererUrl: renderer.endpoint,
      targetId: "window-a",
    });
    assert.equal(selected.ok, true);
    assert.equal(selected.data.selectedTarget?.id, "window-a");

    const refreshed = await manager.refreshTargets({
      rendererUrl: renderer.endpoint,
      clearSelection: true,
    });
    assert.equal(refreshed.ok, true);
    if (!refreshed.ok) {
      return;
    }
    assert.ok(refreshed.data.errors.some((error) => error.code === "TARGET_SELECTION_REQUIRED"));
    assert.equal(refreshed.data.selectedTarget, undefined);
  } finally {
    await renderer.close();
  }
});
