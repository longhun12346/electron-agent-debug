import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { once } from "node:events";
import { createServer, type Server } from "node:http";
import { promisify } from "node:util";
import test, { type TestContext } from "node:test";
import { WebSocketServer } from "ws";
import { JsonRpcConnection } from "../src/protocol/json-rpc-connection.js";

const execFileAsync = promisify(execFile);

async function protocolPeer(t: TestContext, timeoutMs = 1_000) {
  const peer = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await once(peer, "listening");
  const address = peer.address();
  assert.ok(address && typeof address === "object");
  const connection = new JsonRpcConnection({
    requestTimeoutMs: timeoutMs,
    maxMessageBytes: 4_096,
  });
  t.after(async () => {
    await connection.close();
    for (const socket of peer.clients) socket.terminate();
    await new Promise<void>((resolve) => peer.close(() => resolve()));
  });
  return { peer, connection, url: `ws://127.0.0.1:${address.port}` };
}

test("malformed protocol frames cannot crash the client or consume a pending response",
  { timeout: 10_000 }, async (t) => {
    const { peer, url } = await protocolPeer(t);
    const malformed = [
      "null", "true", "42", '"text"', "[]", "{",
      '{"id":1}', '{"id":"1","result":{}}',
      '{"id":1,"error":true}',
      '{"id":1,"error":{"code":"bad","message":42}}',
      '{"id":1,"result":{},"error":{"code":-1,"message":"bad"}}',
      '{"method":42}', '{}',
    ];
    peer.on("connection", (socket) => {
      socket.on("message", (raw) => {
        const request = JSON.parse(raw.toString()) as { id: number };
        for (const frame of malformed) socket.send(frame);
        socket.send(JSON.stringify({ method: "Runtime.consoleAPICalled", params: { args: [] } }));
        socket.send(JSON.stringify({ id: request.id, result: { alive: true } }));
      });
    });
    const moduleUrl = new URL("../dist/protocol/json-rpc-connection.js", import.meta.url).href;
    const source = `
      import { JsonRpcConnection } from ${JSON.stringify(moduleUrl)};
      const events = [];
      const connection = new JsonRpcConnection({
        requestTimeoutMs: 1000, maxMessageBytes: 4096,
        onEvent: event => events.push(event.method),
      });
      try {
        await connection.connect(process.argv[1]);
        const result = await connection.request("Probe");
        console.log(JSON.stringify({ result, events, online: connection.isOpen }));
      } finally {
        await connection.close();
      }
    `;
    const { stdout } = await execFileAsync(process.execPath, ["--input-type=module", "-e", source, url],
      { timeout: 5_000 });
    const actual = JSON.parse(stdout) as { result: unknown; events: string[]; online: boolean };
    assert.deepEqual(actual.result, { alive: true });
    assert.equal(actual.online, true);
    assert.equal(actual.events.filter((event) => event === "protocolError").length, malformed.length);
    assert.ok(actual.events.includes("Runtime.consoleAPICalled"));
  });

test("routes concurrent responses by request id rather than arrival order", async (t) => {
  const { peer, connection, url } = await protocolPeer(t);
  peer.on("connection", (socket) => {
    const requests: Array<{ id: number; method: string }> = [];
    socket.on("message", (raw) => {
      requests.push(JSON.parse(raw.toString()));
      if (requests.length === 2) {
        for (const request of requests.reverse()) {
          socket.send(JSON.stringify({ id: request.id, result: request.method }));
        }
      }
    });
  });
  await connection.connect(url);
  assert.deepEqual(await Promise.all([connection.request("first"), connection.request("second")]),
    ["first", "second"]);
});

test("returns a protocol error for a rejected command and keeps the connection usable", async (t) => {
  const { peer, connection, url } = await protocolPeer(t);
  peer.on("connection", (socket) => socket.on("message", (raw) => {
    const request = JSON.parse(raw.toString()) as { id: number; method: string };
    socket.send(JSON.stringify(request.method === "unsupported"
      ? { id: request.id, error: { code: -32601, message: "unsupported method" } }
      : { id: request.id, result: {} }));
  }));
  await connection.connect(url);
  await assert.rejects(connection.request("unsupported"), /unsupported method/u);
  assert.deepEqual(await connection.request("supported"), {});
});

test("times out an unanswered request without blocking later requests", async (t) => {
  const { peer, connection, url } = await protocolPeer(t, 200);
  peer.on("connection", (socket) => socket.on("message", (raw) => {
    const request = JSON.parse(raw.toString()) as { id: number; method: string };
    if (request.method !== "unanswered") {
      socket.send(JSON.stringify({ id: request.id, result: {} }));
    }
  }));
  await connection.connect(url);
  await assert.rejects(connection.request("unanswered"), /超时/u);
  assert.deepEqual(await connection.request("next"), {});
});

test("disconnect rejects all pending requests", async (t) => {
  const { peer, connection, url } = await protocolPeer(t);
  peer.on("connection", (socket) => {
    let requests = 0;
    socket.on("message", () => {
      if (++requests === 2) socket.close(1000, "peer disconnected");
    });
  });
  await connection.connect(url);
  const result = await Promise.allSettled([connection.request("first"), connection.request("second")]);
  assert.ok(result.every((item) =>
    item.status === "rejected" && /peer disconnected/u.test(String(item.reason))));
  assert.equal(connection.isOpen, false);
});

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
