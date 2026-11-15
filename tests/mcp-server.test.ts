import assert from "node:assert/strict";
import { once } from "node:events";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createServer } from "node:http";
import test from "node:test";
import { WebSocketServer } from "ws";
import { createMcpServer } from "../src/server.js";
import { SessionManager } from "../src/sessions/session-manager.js";
import type { RuntimeConfig } from "../src/config.js";
import type { DiagnosticEvent } from "../src/types.js";

interface JsonRpcMessage {
  id?: number;
  result?: {
    tools?: Array<{ name: string }>;
    structuredContent?: {
      ok?: boolean;
      error?: { code?: string };
      data?: { main?: { status?: string }; events?: DiagnosticEvent[] };
    };
  };
}

class McpProcess {
  private readonly child: ChildProcessWithoutNullStreams;
  private buffer = "";
  private readonly pending = new Map<number, {
    resolve: (message: JsonRpcMessage) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
  }>();
  private failure?: Error;

  constructor() {
    const env = { ...process.env };
    for (const name of Object.keys(env)) {
      if (name.startsWith("ELECTRON_DEBUG_")) delete env[name];
    }
    this.child = spawn(process.execPath, ["dist/index.js"], {
      stdio: ["pipe", "pipe", "pipe"],
      env,
    });
    this.child.once("error", (error) => this.fail(error));
    this.child.once("exit", (code, signal) =>
      this.fail(new Error(`MCP process exited: ${code ?? signal}`)));
    this.child.stdout.on("data", (chunk: Buffer) => {
      this.buffer += chunk.toString();
      const lines = this.buffer.split("\n");
      this.buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) {
          continue;
        }
        let message: JsonRpcMessage;
        try {
          message = JSON.parse(line) as JsonRpcMessage;
        } catch {
          this.fail(new Error("MCP stdout contained invalid JSON"));
          continue;
        }
        if (typeof message.id === "number") {
          const pending = this.pending.get(message.id);
          if (pending) {
            clearTimeout(pending.timer);
            pending.resolve(message);
          }
          this.pending.delete(message.id);
        }
      }
    });
  }

  async request(id: number, method: string, params: unknown): Promise<JsonRpcMessage> {
    if (this.failure) throw this.failure;
    const response = new Promise<JsonRpcMessage>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP request timed out: ${method}`));
      }, 5_000);
      this.pending.set(id, { resolve, reject, timer });
    });
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    return response;
  }

  notify(method: string, params: unknown): void {
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
  }

  private fail(error: Error): void {
    this.failure = error;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  async close(): Promise<void> {
    if (this.child.exitCode !== null || this.child.signalCode !== null) {
      return;
    }
    const exited = once(this.child, "exit");
    this.child.kill();
    await exited.catch(() => undefined);
  }
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
