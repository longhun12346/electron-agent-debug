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

test("evaluation is off for 0, false, off, no and disabled, on for 1, true, on, yes and enabled, and anything else is an error", () => {
  for (const value of ["0", "false", "off", "no", "disabled", " OFF "]) {
    assert.equal(readRuntimeConfig({ ELECTRON_DEBUG_ALLOW_EVAL: value }).allowEval, false, value);
  }
  for (const value of ["", "1", "true", "on", "yes", "enabled", " Yes "]) {
    assert.equal(readRuntimeConfig({ ELECTRON_DEBUG_ALLOW_EVAL: value }).allowEval, true, value);
  }
  // A value that is not recognised must not leave evaluation on while the host thinks it is off.
  for (const value of ["none", "disable", "n", "f", "2", "maybe"]) {
    assert.throws(() => readRuntimeConfig({ ELECTRON_DEBUG_ALLOW_EVAL: value }), (error: unknown) =>
      error instanceof DiagnosticException
      && error.diagnostic.code === "ENDPOINT_CONFIG_INVALID"
      && error.diagnostic.message.includes("ELECTRON_DEBUG_ALLOW_EVAL"), value);
  }
});

test("a numeric setting out of range names the variable and the allowed range", () => {
  assert.throws(() => readRuntimeConfig({ ELECTRON_DEBUG_MAX_LOG_EVENTS: "5" }), (error: unknown) =>
    error instanceof DiagnosticException
    && error.diagnostic.message.includes("ELECTRON_DEBUG_MAX_LOG_EVENTS")
    && error.diagnostic.message.includes("10")
    && error.diagnostic.message.includes("10000")
    && typeof error.diagnostic.hint === "string");
});

test("defaults the protocol message limit to the 256 MiB that Puppeteer and Playwright accept", () => {
  assert.equal(readRuntimeConfig({}).maxProtocolMessageBytes, 268_435_456);
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

test("every bounded setting validates both bounds, invalid numbers and a blank fallback", () => {
for (const [name, key, minimum, maximum] of [
  ["ELECTRON_DEBUG_REQUEST_TIMEOUT_MS", "requestTimeoutMs", 100, 30_000],
  ["ELECTRON_DEBUG_DISCOVERY_TIMEOUT_MS", "discoveryTimeoutMs", 100, 30_000],
  ["ELECTRON_DEBUG_MAX_LOG_EVENTS", "maxLogEvents", 10, 10_000],
  ["ELECTRON_DEBUG_MAX_LOG_BYTES", "maxLogBytes", 4_096, 16_777_216],
  ["ELECTRON_DEBUG_MAX_PROTOCOL_MESSAGE_BYTES", "maxProtocolMessageBytes", 4_096, 268_435_456],
] as const) {
  {
    for (const value of [minimum, maximum]) {
      assert.equal(readRuntimeConfig({ [name]: String(value) })[key], value);
    }
    for (const value of [minimum - 1, maximum + 1, 1.5, "NaN", "Infinity", "invalid"]) {
      assert.throws(() => readRuntimeConfig({ [name]: String(value) }), (error: unknown) =>
        error instanceof DiagnosticException && error.diagnostic.code === "ENDPOINT_CONFIG_INVALID");
    }
    assert.equal(readRuntimeConfig({ [name]: " " })[key], readRuntimeConfig({})[key]);
  }
}
});

test("resolves each endpoint fallback and rejects invalid explicit input without silent fallback", () => {
  const environment = "http://127.0.0.1/environment";
  const session = { url: "http://127.0.0.1/session", source: "attach_input" as const };
  assert.deepEqual(resolveEndpoint(undefined, environment, session, "mainUrl"),
    { url: environment, source: "environment" });
  assert.deepEqual(resolveEndpoint(undefined, " ", session, "mainUrl"),
    { url: session.url, source: "session" });
  assert.equal(resolveEndpoint(undefined, undefined, undefined, "mainUrl"), undefined);
  assert.throws(() => resolveEndpoint("invalid", environment, session, "mainUrl"));
});

test("loopback hosts are accepted in discovery and debugger URLs", () => {
for (const host of ["127.0.0.1", "localhost", "[::1]"]) {
  {
    assert.doesNotThrow(() => validateDiscoveryUrl(`http://${host}:12345`, "mainUrl"));
    assert.doesNotThrow(() => validateDebuggerWebSocketUrl(`ws://${host}:12345/a`));
  }
}
});

test("credentials, queries and fragments are rejected in both URL kinds", () => {
for (const suffix of ["user:secret@127.0.0.1/a", "127.0.0.1/a?token=secret", "127.0.0.1/a#fragment"]) {
  {
    assert.throws(() => validateDiscoveryUrl(`http://${suffix}`, "mainUrl"));
    assert.throws(() => validateDebuggerWebSocketUrl(`ws://${suffix}`));
  }
}
});
