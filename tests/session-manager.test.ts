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
  close(): Promise<void>;
}

async function startMockDebugger(targets: Array<Pick<TargetInfo, "id" | "type" | "title" | "url">>): Promise<MockDebugger> {
  const httpServer = createServer();
  const wsServer = new WebSocketServer({ server: httpServer });
  const sockets = new Set<WebSocket>();

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
    const body = targets.map((target) => ({
      ...target,
      webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/page/${target.id}`,
    }));
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify(body));
  });

  return {
    endpoint,
    broadcast(message) {
      const raw = JSON.stringify(message);
      for (const socket of sockets) {
        socket.send(raw);
      }
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
