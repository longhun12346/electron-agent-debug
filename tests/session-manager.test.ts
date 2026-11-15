import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import test from "node:test";
import { WebSocketServer, type WebSocket } from "ws";
import { SessionManager } from "../src/sessions/session-manager.js";
import type { RuntimeConfig } from "../src/config.js";
import type { TargetInfo } from "../src/types.js";

interface MockDebugger {
  endpoint: string;
  broadcast(message: unknown): void;
  setTargets(targets: Array<Pick<TargetInfo, "id" | "type" | "title" | "url">>): void;
  close(): Promise<void>;
}

interface MockDebuggerOptions {
  discoveryDelayMs?: number;
}

async function startMockDebugger(
  targets: Array<Pick<TargetInfo, "id" | "type" | "title" | "url">>,
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
      const message = JSON.parse(raw.toString()) as { id?: number };
      if (message.id !== undefined) {
        socket.send(JSON.stringify({ id: message.id, result: { ok: true } }));
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
        webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/page/${target.id}`,
      }));
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(body));
    };
    if (options.discoveryDelayMs) {
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
  };
}

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
    assert.ok(logs.some((event) => event.process === "renderer" && event.message.includes("renderer-ready")));
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
