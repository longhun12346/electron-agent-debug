import assert from "node:assert/strict";
import test from "node:test";
import { instrumentIpcScript, ipcEvent } from "../src/ipc.js";

// The script itself runs in a real main process in examples/fixture/inspection-smoke.mjs; here the parts that do not
// need Electron: it parses, and binding payloads become readable, redacted timeline events.

test("the IPC instrumentation is valid JavaScript", () => {
  assert.doesNotThrow(() => new Function(`return ${instrumentIpcScript}`));
});

test("a failed invoke becomes an error event with the handler's message", () => {
  const event = ipcEvent("main", JSON.stringify({
    type: "invoke", channel: "app:save", ok: false, ms: 12, argBytes: 40, senderId: 1,
    error: "Error: disk full token=abc123secret",
  }))!;
  assert.equal(event.kind, "ipc");
  assert.equal(event.level, "error");
  assert.match(event.message, /^IPC invoke app:save failed after 12ms: Error: disk full/u);
  assert.doesNotMatch(event.message, /abc123secret/u, "the error text is redacted");
  assert.deepEqual(
    { channel: (event.data as Record<string, unknown>).channel, ok: (event.data as Record<string, unknown>).ok },
    { channel: "app:save", ok: false },
  );
});

test("a send nobody listens to is a warning, a handled one is info", () => {
  const unheard = ipcEvent("main", JSON.stringify({ type: "send", channel: "app:ping", ok: true, ms: 0, listeners: 0 }))!;
  assert.equal(unheard.level, "warn");
  assert.match(unheard.message, /no listener in the main process/u);
  const heard = ipcEvent("main", JSON.stringify({ type: "sendSync", channel: "app:ping", ok: true, ms: 1, listeners: 1 }))!;
  assert.equal(heard.level, "info");
  assert.equal(heard.message, "IPC sendSync app:ping ok in 1ms");
  const skipped = ipcEvent("main", JSON.stringify({ type: "send", channel: "app:tick", ok: true, ms: 0, listeners: 1, skipped: 21 }))!;
  assert.equal((skipped.data as Record<string, unknown>).skipped, 21);
});

test("payloads that are not IPC records are ignored", () => {
  assert.equal(ipcEvent("main", "not json"), undefined);
  assert.equal(ipcEvent("main", JSON.stringify({ type: "send" })), undefined, "a record needs a channel");
});
