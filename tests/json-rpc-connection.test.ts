import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import test from "node:test";
import { WebSocketServer } from "ws";
import { JsonRpcConnection } from "../src/protocol/json-rpc-connection.js";

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return `ws://127.0.0.1:${address.port}`;
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

test("closes a connection when a protocol message exceeds the configured limit", async () => {
  const httpServer = createServer();
  const wsServer = new WebSocketServer({ server: httpServer });
  let resolveCloseReason!: (reason: string) => void;
  const observedCloseReason = new Promise<string>((resolve) => {
    resolveCloseReason = resolve;
  });
  wsServer.on("connection", (socket) => {
    socket.send("x".repeat(8_192));
  });
  const connection = new JsonRpcConnection({
    requestTimeoutMs: 1_000,
    maxMessageBytes: 4_096,
    onClose: resolveCloseReason,
  });

  try {
    const endpoint = await listen(httpServer);
    await connection.connect(endpoint);
    const reason = await Promise.race([
      observedCloseReason,
      new Promise<string>((_, reject) =>
        setTimeout(() => reject(new Error("timed out waiting for oversized message close")), 2_000),
      ),
    ]);
    assert.match(reason, /Max payload size exceeded|WebSocket 已关闭/i);
    assert.equal(connection.isOpen, false);
  } finally {
    await connection.close();
    await new Promise<void>((resolve) => wsServer.close(() => resolve()));
    await close(httpServer);
  }
});
