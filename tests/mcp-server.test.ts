import assert from "node:assert/strict";
import { once } from "node:events";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import test from "node:test";
import { createMcpServer } from "../src/server.js";
import { SessionManager } from "../src/sessions/session-manager.js";
import type { RuntimeConfig } from "../src/config.js";

interface JsonRpcMessage {
  id?: number;
  result?: {
    tools?: Array<{ name: string }>;
    structuredContent?: {
      ok?: boolean;
      error?: { code?: string };
      data?: { main?: { status?: string } };
    };
  };
}

class McpProcess {
  private readonly child: ChildProcessWithoutNullStreams;
  private buffer = "";
  private readonly pending = new Map<number, (message: JsonRpcMessage) => void>();

  constructor() {
    this.child = spawn(process.execPath, ["dist/index.js"], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env },
    });
    this.child.stdout.on("data", (chunk: Buffer) => {
      this.buffer += chunk.toString();
      const lines = this.buffer.split("\n");
      this.buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) {
          continue;
        }
        const message = JSON.parse(line) as JsonRpcMessage;
        if (typeof message.id === "number") {
          this.pending.get(message.id)?.(message);
          this.pending.delete(message.id);
        }
      }
    });
  }

  async request(id: number, method: string, params: unknown): Promise<JsonRpcMessage> {
    const response = new Promise<JsonRpcMessage>((resolve) => this.pending.set(id, resolve));
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    return response;
  }

  notify(method: string, params: unknown): void {
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
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
