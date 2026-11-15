import assert from "node:assert/strict";
import test from "node:test";
import { assertSmokeResults, hasExpectedEvidence } from "../examples/fixture/smoke-assertions.mjs";

const target = { id: "window" };
const online = {
  main: { online: true }, renderer: { online: true }, selectedTarget: target,
};
const targets = { targets: [target], selectedTarget: target };
const ipcEvents = [
  { process: "renderer", message: "FIXTURE_IPC_CALL_FAILURE" },
  { process: "main", message: "FIXTURE_IPC_HANDLER_FAILURE" },
];

test("IPC smoke requires both messages in their respective channels", () => {
  assertSmokeResults(online, online, targets, { events: ipcEvents }, "ipc");
  for (const incomplete of [
    [], [ipcEvents[0]], [ipcEvents[1]],
    ipcEvents.map((event) => ({ ...event, process: "main" })),
    ipcEvents.map((event) => ({ ...event, process: "renderer" })),
    ipcEvents.map((event) => ({ ...event, process: event.process === "main" ? "renderer" : "main" })),
  ]) {
    assert.equal(hasExpectedEvidence(incomplete, "ipc"), false);
    assert.throws(() => assertSmokeResults(online, online, targets, { events: incomplete }, "ipc"),
      /missing scoped fixture evidence/u);
  }
});

test("main-window smoke requires main failure and no live renderer target", () => {
  const offline = { main: { online: true }, renderer: { online: false } };
  const logs = { events: [{ process: "main", message: "FIXTURE_MAIN_WINDOW_FAILURE" }] };
  assertSmokeResults(offline, offline, { targets: [] }, logs, "main-window");
  assert.throws(() => assertSmokeResults(online, online, targets, logs, "main-window"),
    /must not report/u);
  assert.throws(() => assertSmokeResults(offline, offline, {}, { events: [] }, "main-window"),
    /missing scoped fixture evidence/u);
});
