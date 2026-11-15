import assert from "node:assert/strict";
import { createServer, type Server, type RequestListener } from "node:http";
import test, { type TestContext } from "node:test";
import { discoverMain, discoverRenderer } from "../src/discovery.js";
import { DiagnosticException } from "../src/errors.js";

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return `http://127.0.0.1:${address.port}`;
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

async function endpointFor(t: TestContext, listener: RequestListener): Promise<string> {
  const server = createServer(listener);
  const endpoint = await listen(server);
  t.after(async () => {
    server.closeAllConnections();
    await close(server);
  });
  return endpoint;
}

for (const [channel, discover] of [
  ["main", discoverMain], ["renderer", discoverRenderer],
] as const) {
  for (const [description, body] of [
    ["invalid JSON", "{"],
    ["non-array JSON", '{"targets":[]}'],
    ["missing target ID", '[{"type":"page"}]'],
    ["null target", "[null]"],
    ["remote WebSocket", '[{"id":"a","webSocketDebuggerUrl":"ws://192.0.2.1/a"}]'],
    ["credentialed WebSocket", '[{"id":"a","webSocketDebuggerUrl":"ws://user:secret@127.0.0.1/a"}]'],
  ]) {
    test(`${channel} discovery rejects ${description}`, async (t) => {
      const endpoint = await endpointFor(t, (_request, response) => response.end(body));
      await assert.rejects(discover(endpoint, { timeoutMs: 1_000 }), (error: unknown) => {
        assert.ok(error instanceof DiagnosticException);
        assert.equal(error.diagnostic.code,
          description === "remote WebSocket" ? "NON_LOOPBACK_ENDPOINT" : "PROTOCOL_ERROR");
        assert.equal(error.diagnostic.retryable, false);
        return true;
      });
    });
  }

  for (const status of [404, 503]) {
    test(`${channel} discovery classifies HTTP ${status}`, async (t) => {
      const endpoint = await endpointFor(t, (_request, response) =>
        response.writeHead(status).end());
      await assert.rejects(discover(endpoint, { timeoutMs: 1_000 }), (error: unknown) => {
        assert.ok(error instanceof DiagnosticException);
        assert.equal(error.diagnostic.code, "PROTOCOL_ERROR");
        assert.equal(error.diagnostic.retryable, status >= 500);
        return true;
      });
    });
  }

  for (const phase of ["headers", "body"] as const) {
    test(`${channel} discovery bounds stalled ${phase} and reports a retryable timeout`,
      { timeout: 3_000 }, async (t) => {
        const endpoint = await endpointFor(t, (_request, response) => {
          if (phase === "body") {
            response.writeHead(200, { "content-type": "application/json" });
            response.write("[");
          }
        });
        const before = Date.now();
        await assert.rejects(discover(endpoint, { timeoutMs: 100 }), (error: unknown) => {
          assert.ok(error instanceof DiagnosticException);
          assert.equal(error.diagnostic.retryable, true);
          assert.doesNotMatch(error.diagnostic.message, /不是有效 JSON/u);
          return true;
        });
        assert.ok(Date.now() - before < 2_000);
      });
  }

  test(`${channel} discovery classifies a truncated transport as retryable`, async (t) => {
    const endpoint = await endpointFor(t, (_request, response) => {
      response.write("[");
      setTimeout(() => response.destroy(), 20);
    });
    await assert.rejects(discover(endpoint, { timeoutMs: 1_000 }), (error: unknown) => {
      assert.ok(error instanceof DiagnosticException);
      assert.equal(error.diagnostic.retryable, true);
      assert.doesNotMatch(error.diagnostic.message, /不是有效 JSON/u);
      return true;
    });
  });
}

test("HTTP errors cancel an unending response body before the discovery timeout",
  { timeout: 3_000 }, async (t) => {
    let closed = false;
    const endpoint = await endpointFor(t, (request, response) => {
      request.socket.once("close", () => { closed = true; });
      response.writeHead(503);
      response.write("still streaming");
    });
    await assert.rejects(discoverRenderer(endpoint, { timeoutMs: 2_000 }));
    const deadline = Date.now() + 300;
    while (!closed && Date.now() < deadline) {
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(closed, true, "HTTP failure must cancel its response stream promptly");
  });

test("renderer accepts an empty list while main requires a connectable target", async (t) => {
  const endpoint = await endpointFor(t, (_request, response) => response.end("[]"));
  assert.deepEqual((await discoverRenderer(endpoint, { timeoutMs: 1_000 })).targets, []);
  await assert.rejects(discoverMain(endpoint, { timeoutMs: 1_000 }), (error: unknown) =>
    error instanceof DiagnosticException && error.diagnostic.code === "MAIN_INSPECTOR_UNAVAILABLE");
});

test("rejects oversized content-length without waiting for the response body", async (t) => {
  const endpoint = await endpointFor(t, (_request, response) => {
    response.writeHead(200, { "content-length": "2000000" });
    response.flushHeaders();
  });
  await assert.rejects(discoverRenderer(endpoint, { timeoutMs: 1_000 }), (error: unknown) =>
    error instanceof DiagnosticException && error.diagnostic.code === "OUTPUT_TOO_LARGE");
});

test("does not follow discovery redirects", async () => {
  const target = createServer((_request, response) => {
    response.setHeader("content-type", "application/json");
    response.end("[]");
  });
  const targetEndpoint = await listen(target);
  const redirect = createServer((_request, response) => {
    response.writeHead(302, { location: `${targetEndpoint}/json/list` });
    response.end();
  });
  const redirectEndpoint = await listen(redirect);

  try {
    await assert.rejects(
      () => discoverRenderer(redirectEndpoint, { timeoutMs: 1_000 }),
      (error: unknown) =>
        error instanceof DiagnosticException &&
        error.diagnostic.code === "RENDERER_CDP_UNAVAILABLE",
    );
  } finally {
    await Promise.all([close(redirect), close(target)]);
  }
});

test("stops reading an oversized discovery response", async () => {
  const server = createServer((_request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(`[{"id":"${"x".repeat(1_100_000)}"}]`);
  });
  const endpoint = await listen(server);

  try {
    await assert.rejects(
      () => discoverRenderer(endpoint, { timeoutMs: 1_000 }),
      (error: unknown) =>
        error instanceof DiagnosticException &&
        error.diagnostic.code === "OUTPUT_TOO_LARGE",
    );
  } finally {
    await close(server);
  }
});
