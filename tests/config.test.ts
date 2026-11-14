import assert from "node:assert/strict";
import test from "node:test";
import {
  discoveryUrl,
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
  assert.equal(validateDiscoveryUrl("http://127.0.0.1:43123", "mainUrl"), "http://127.0.0.1:43123");
  assert.equal(validateDiscoveryUrl("http://[::1]:43123", "mainUrl"), "http://[::1]:43123");
  assert.equal(codeOf(() => validateDiscoveryUrl("http://192.168.1.2:43123", "mainUrl")), "NON_LOOPBACK_ENDPOINT");
  assert.equal(codeOf(() => validateDiscoveryUrl("ws://127.0.0.1:43123", "mainUrl")), "ENDPOINT_CONFIG_INVALID");
  assert.equal(
    codeOf(() => validateDiscoveryUrl("http://127.0.0.1:43123?token=secret", "mainUrl")),
    "ENDPOINT_CONFIG_INVALID",
  );
});

test("validates discovery websocket URLs independently", () => {
  assert.equal(
    validateDebuggerWebSocketUrl("ws://127.0.0.1:43123/devtools/page/a"),
    "ws://127.0.0.1:43123/devtools/page/a",
  );
  assert.equal(codeOf(() => validateDebuggerWebSocketUrl("ws://10.0.0.2/devtools/page/a")), "NON_LOOPBACK_ENDPOINT");
  assert.equal(codeOf(() => validateDebuggerWebSocketUrl("http://127.0.0.1/devtools/page/a")), "NON_LOOPBACK_ENDPOINT");
});

test("resolves input before environment and session values", () => {
  const resolved = resolveEndpoint(
    "http://127.0.0.1:40001",
    "http://127.0.0.1:40002",
    { url: "http://127.0.0.1:40003", source: "session" },
    "mainUrl",
  );
  assert.deepEqual(resolved, { url: "http://127.0.0.1:40001", source: "attach_input" });
});

test("builds the discovery path without changing an explicit json list path", () => {
  assert.equal(discoveryUrl("http://127.0.0.1:43123"), "http://127.0.0.1:43123/json/list");
  assert.equal(discoveryUrl("http://127.0.0.1:43123/json/list"), "http://127.0.0.1:43123/json/list");
});
