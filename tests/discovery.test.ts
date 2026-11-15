import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import test from "node:test";
import { discoverRenderer } from "../src/discovery.js";
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
