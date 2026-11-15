import assert from "node:assert/strict";
import test from "node:test";
import {
  discoveryUrl,
  readRuntimeConfig,
  resolveEndpoint,
  validateDebuggerWebSocketUrl,
  validateDiscoveryUrl,
} from "../src/config.js";
import { DiagnosticException } from "../src/errors.js";

function codeOf(callback: () => unknown): string {
  try {
    callback();
  } catch (error) {
    assert.ok(error instanceof DiagnosticException);
    return error.diagnostic.code;
  }
  throw new Error("expected callback to throw");
}

test("accepts only loopback discovery URLs", () => {
  assert.equal(validateDiscoveryUrl("http://127.0.0.1", "mainUrl"), "http://127.0.0.1");
  assert.equal(validateDiscoveryUrl("http://[::1]", "mainUrl"), "http://[::1]");
  assert.equal(codeOf(() => validateDiscoveryUrl("http://192.168.1.2", "mainUrl")), "NON_LOOPBACK_ENDPOINT");
  assert.equal(codeOf(() => validateDiscoveryUrl("ws://127.0.0.1", "mainUrl")), "ENDPOINT_CONFIG_INVALID");
  assert.equal(
    codeOf(() => validateDiscoveryUrl("http://127.0.0.1?token=secret", "mainUrl")),
    "ENDPOINT_CONFIG_INVALID",
  );
});

test("validates discovery websocket URLs independently", () => {
  assert.equal(
    validateDebuggerWebSocketUrl("ws://127.0.0.1/devtools/page/a"),
    "ws://127.0.0.1/devtools/page/a",
  );
  assert.equal(codeOf(() => validateDebuggerWebSocketUrl("ws://10.0.0.2/devtools/page/a")), "NON_LOOPBACK_ENDPOINT");
  assert.equal(codeOf(() => validateDebuggerWebSocketUrl("http://127.0.0.1/devtools/page/a")), "NON_LOOPBACK_ENDPOINT");
});

test("resolves input before environment and session values", () => {
  const resolved = resolveEndpoint(
    "http://127.0.0.1/main",
    "http://127.0.0.1/environment",
    { url: "http://127.0.0.1/session", source: "session" },
    "mainUrl",
  );
  assert.deepEqual(resolved, { url: "http://127.0.0.1/main", source: "attach_input" });
});

test("builds the discovery path without changing an explicit json list path", () => {
  assert.equal(discoveryUrl("http://127.0.0.1"), "http://127.0.0.1/json/list");
  assert.equal(discoveryUrl("http://127.0.0.1/json/list"), "http://127.0.0.1/json/list");
});

test("reads a bounded protocol message limit", () => {
  const config = readRuntimeConfig({
    ELECTRON_DEBUG_MAX_PROTOCOL_MESSAGE_BYTES: "8192",
  });
  assert.equal(config.maxProtocolMessageBytes, 8192);
  assert.throws(
    () =>
      readRuntimeConfig({
        ELECTRON_DEBUG_MAX_PROTOCOL_MESSAGE_BYTES: "1024",
      }),
    (error: unknown) =>
      error instanceof DiagnosticException &&
      error.diagnostic.code === "ENDPOINT_CONFIG_INVALID",
  );
});
