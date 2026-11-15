import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { WebSocketServer } from "ws";
import { createMcpServer } from "../src/server.js";
import { SessionManager } from "../src/sessions/session-manager.js";
import type { RuntimeConfig } from "../src/config.js";
import { McpProcess } from "./helpers/mcp-process.js";

for (const shutdown of ["stdin-eof", ...(process.platform === "win32" ? [] : ["sigterm"])] as const) {
  test(`MCP ${shutdown} exits cleanly and releases both active debugger sockets`,
    { timeout: 10_000 }, async (t) => {
      const peer = new WebSocketServer({ port: 0, host: "127.0.0.1" });
      await new Promise<void>((resolve) => peer.once("listening", resolve));
      const address = peer.address();
      assert.ok(address && typeof address === "object");
      peer.on("connection", (socket) => socket.on("message", (raw) => {
        const { id } = JSON.parse(raw.toString()) as { id: number };
        socket.send(JSON.stringify({ id, result: {} }));
      }));
      const client = new McpProcess();
      t.after(async () => {
        await client.close();
        for (const socket of peer.clients) socket.terminate();
        await new Promise<void>((resolve) => peer.close(() => resolve()));
      });
      await client.request(1, "initialize", {
        protocolVersion: "2025-03-26", capabilities: {},
        clientInfo: { name: "shutdown-contract", version: "1.0.0" },
      });
      client.notify("notifications/initialized", {});
      // Keep HTTP discovery separate so both active WebSockets can be counted directly.
      const discovery = createServer((_request, response) => response.end(JSON.stringify([
        { id: "main", type: "node",
          webSocketDebuggerUrl: `ws://127.0.0.1:${address.port}/main` },
        { id: "renderer", type: "page",
          webSocketDebuggerUrl: `ws://127.0.0.1:${address.port}/renderer` },
      ])));
      await new Promise<void>((resolve) => discovery.listen(0, "127.0.0.1", resolve));
      t.after(() => new Promise<void>((resolve) => {
        discovery.closeAllConnections();
        discovery.close(() => resolve());
      }));
      const discoveryAddress = discovery.address();
      assert.ok(discoveryAddress && typeof discoveryAddress === "object");
      const url = `http://127.0.0.1:${discoveryAddress.port}`;
      const response = await client.request(2, "tools/call", {
        name: "electron_attach", arguments: { mainUrl: url, rendererUrl: url },
      });
      assert.equal(response.result?.structuredContent?.data?.main?.status, "online");
      assert.equal(peer.clients.size, 2);
      if (shutdown === "stdin-eof") client.child.stdin.end();
      else client.child.kill("SIGTERM");
      await client.waitForExit();
      assert.equal(client.child.exitCode, 0, "must exit naturally without the test killing it");
      const deadline = Date.now() + 1_000;
      while (peer.clients.size && Date.now() < deadline) {
        await new Promise<void>((resolve) => setTimeout(resolve, 10));
      }
      assert.equal(peer.clients.size, 0);
    });
}

test("MCP stdio preserves log scope and scoped clearing through tools/call",
  { timeout: 15_000 }, async () => {
    const debuggerServer = createServer();
    const sockets = new WebSocketServer({ server: debuggerServer });
    await new Promise<void>((resolve) => debuggerServer.listen(0, "127.0.0.1", resolve));
    const address = debuggerServer.address();
    assert.ok(address && typeof address === "object");
    const endpoint = `http://127.0.0.1:${address.port}`;
    debuggerServer.on("request", (_request, response) => {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify([
        { id: "main", type: "node", title: "Main", url: "",
          webSocketDebuggerUrl: `ws://127.0.0.1:${address.port}/main` },
        { id: "renderer", type: "page", title: "Renderer", url: "app://test",
          webSocketDebuggerUrl: `ws://127.0.0.1:${address.port}/renderer` },
      ]));
    });
    sockets.on("connection", (socket, request) => socket.on("message", (raw) => {
      const message = JSON.parse(raw.toString()) as { id: number; method: string };
      if (message.method === "Runtime.enable") {
        socket.send(JSON.stringify({
          method: "Runtime.consoleAPICalled",
          params: { type: "error", args: [{ value: `${request.url}-evidence` }] },
        }));
      }
      socket.send(JSON.stringify({ id: message.id, result: {} }));
    }));
    const client = new McpProcess();
    try {
      await client.request(1, "initialize", {
        protocolVersion: "2025-03-26", capabilities: {},
        clientInfo: { name: "log-contract", version: "1.0.0" },
      });
      client.notify("notifications/initialized", {});
      const attached = await client.request(2, "tools/call", {
        name: "electron_attach", arguments: { mainUrl: endpoint, rendererUrl: endpoint },
      });
      assert.equal(attached.result?.structuredContent?.ok, true);
      let id = 3;
      for (const scope of ["main", "renderer"] as const) {
        const response = await client.request(id++, "tools/call", {
          name: "electron_logs", arguments: { process: scope, level: "error" },
        });
        const events = response.result?.structuredContent?.data?.events;
        assert.deepEqual(events?.map((event) => [event.process, event.message]),
          [[scope, `/${scope}-evidence`]]);
      }
      await client.request(id++, "tools/call", {
        name: "electron_logs", arguments: { process: "main", clear: true },
      });
      const remaining = await client.request(id++, "tools/call", {
        name: "electron_logs", arguments: { process: "all", level: "error" },
      });
      assert.deepEqual(
        remaining.result?.structuredContent?.data?.events?.map((event) => event.process),
        ["renderer"],
      );
    } finally {
      await client.close();
      for (const socket of sockets.clients) socket.terminate();
      await new Promise<void>((resolve) => sockets.close(() => resolve()));
      await new Promise<void>((resolve) => debuggerServer.close(() => resolve()));
    }
  });

test("registers exactly the four core tools", async () => {
  const process = new McpProcess();
  try {
    await process.request(1, "initialize", {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "test", version: "1.0.0" },
    });
    process.notify("notifications/initialized", {});
    const response = await process.request(2, "tools/list", {});
    assert.deepEqual(
      response.result?.tools?.map((tool) => tool.name),
      ["electron_attach", "electron_status", "electron_targets", "electron_logs"],
    );
  } finally {
    await process.close();
  }
});

test("returns a structured prerequisite error without endpoint configuration", async () => {
  const process = new McpProcess();
  try {
    await process.request(1, "initialize", {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "test", version: "1.0.0" },
    });
    process.notify("notifications/initialized", {});
    const response = await process.request(2, "tools/call", {
      name: "electron_attach",
      arguments: {},
    });
    assert.equal(response.result?.structuredContent?.ok, false);
    assert.equal(response.result?.structuredContent?.error?.code, "ENDPOINT_NOT_CONFIGURED");
  } finally {
    await process.close();
  }
});

test("closes the session manager when the MCP server closes", async () => {
  const config: RuntimeConfig = {
    requestTimeoutMs: 1_000,
    discoveryTimeoutMs: 1_000,
    maxLogEvents: 10,
    maxLogBytes: 10_000,
    maxProtocolMessageBytes: 4_096,
  };
  const manager = new SessionManager(config);
  let closeCalls = 0;
  const originalClose = manager.close.bind(manager);
  manager.close = async () => {
    closeCalls += 1;
    await originalClose();
  };

  const server = createMcpServer(manager);
  server.server.onclose?.();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(closeCalls, 1);
});
