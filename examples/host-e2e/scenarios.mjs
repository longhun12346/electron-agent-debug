import assert from "node:assert/strict";
import { hasExpectedEvidence } from "../fixture/smoke-assertions.mjs";

export const allTools = [
  "electron_attach", "electron_status", "electron_targets", "electron_logs",
  "electron_evaluate", "electron_wait_for", "electron_screenshot", "electron_dom_snapshot",
    "electron_click", "electron_type",
];

// Pairs each tools/call request of an MCP trace with the structured result the server answered.
export function callsFromTraffic(traffic) {
  const responses = new Map(traffic.filter(({ direction }) => direction === "response")
    .map(({ message }) => [message.id, message]));
  return traffic
    .filter(({ direction, message }) => direction === "request" && message.method === "tools/call")
    .map(({ message }) => ({
      name: message.params.name,
      args: message.params.arguments ?? {},
      result: responses.get(message.id)?.result?.structuredContent,
    }));
}

// Successful calls of one tool whose data (and arguments) satisfy the predicate.
function succeeded(calls, name, accept = () => true) {
  return calls.filter((call) => call.name === name && call.result?.ok && accept(call.result.data, call.args));
}

function requireTools(calls, tools) {
  for (const name of tools) {
    assert.ok(calls.some((call) => call.name === name),
      `host never invoked ${name}; model text cannot satisfy this assertion`);
  }
}

const boundary = `This is a bounded MCP host integration test. The test runner has already built the
MCP server and started the Electron fixture with Inspector and CDP; do not configure or launch anything.
Only use electron-debug MCP tools, no shell, files, browser, other servers, or subagents. The endpoints are
already configured, so electron_attach needs no endpoint arguments. Report what you observed, then stop.
Do not fix the fixture.`;

const bothOnline = (data) => data.main?.online && data.renderer?.online && data.selectedTarget;

// Each scenario is one task a coding Agent would get. `verify` judges the real MCP traffic only: it checks that the
// host chose the right channels and tools and that the evidence it received is the fixture's, never what the model says.
// `reference` is a scripted run of the same task, so the scenario can be checked without a model.
export const scenarios = {
  ipc: {
    summary: "IPC failure: evidence from both processes",
    fixture: { fault: "ipc" },
    tools: ["electron_attach", "electron_status", "electron_targets", "electron_logs"],
    prompt: `${boundary}
Call electron_attach, electron_status, electron_targets, and electron_logs (process all, limit 100). Both main and
renderer must be online, with a selected target. The fixture intentionally triggers an IPC error: logs must include
FIXTURE_IPC_HANDLER_FAILURE from main and FIXTURE_IPC_CALL_FAILURE from renderer. Retry logs up to 3 times if needed.
Report whether both scoped error messages were observed.`,
    verify(calls) {
      requireTools(calls, ["electron_attach", "electron_status", "electron_targets", "electron_logs"]);
      for (const name of ["electron_attach", "electron_status"]) {
        assert.ok(succeeded(calls, name, bothOnline).length,
          `${name} did not return two live sessions and a selected target`);
      }
      assert.ok(succeeded(calls, "electron_targets", (data) => data.targets.length > 0 && data.selectedTarget).length);
      assert.ok(succeeded(calls, "electron_logs", (data) => hasExpectedEvidence(data.events, "ipc")).length,
        "host did not receive both scoped IPC error messages");
    },
    reference: [
      { tool: "electron_attach" },
      { tool: "electron_status" },
      { tool: "electron_targets" },
      // Each channel has its own connection, so one channel's event can arrive before another's that happened earlier:
      // wait for the evidence of each channel, not for one and then read both.
      { tool: "electron_wait_for", arguments: { log: { contains: "FIXTURE_IPC_CALL_FAILURE", process: "renderer" } } },
      { tool: "electron_wait_for", arguments: { log: { contains: "FIXTURE_IPC_HANDLER_FAILURE", process: "main" } } },
      { tool: "electron_logs", arguments: { process: "all", limit: 100 } },
    ],
  },

  renderer: {
    summary: "White-screen style failure: renderer exception plus what the page shows",
    fixture: { fault: "renderer" },
    tools: ["electron_attach", "electron_logs", "electron_dom_snapshot", "electron_wait_for"],
    prompt: `${boundary}
A developer reports that the fixture page looks wrong and something throws in the page. Attach, then find out what
the renderer reported and what the page actually shows. Use the logs for the error and the accessibility snapshot for
the page content; you cannot open image files, so do not rely on a screenshot. Quote the error text and the page
heading and status text you saw.`,
    verify(calls) {
      requireTools(calls, ["electron_attach", "electron_logs", "electron_dom_snapshot"]);
      assert.ok(succeeded(calls, "electron_attach", (data) => data.renderer?.online).length, "renderer never came online");
      assert.ok(succeeded(calls, "electron_logs", (data) => data.events.some((event) =>
        event.process === "renderer" && event.kind === "exception" &&
        event.message.startsWith("Uncaught Error: fixture renderer failure"))).length,
      "host never received the renderer exception as readable text");
      assert.ok(succeeded(calls, "electron_dom_snapshot", (data) => /renderer-fault/u.test(data.text)).length,
        "host never read the page content that shows the fault state");
    },
    reference: [
      { tool: "electron_attach" },
      { tool: "electron_wait_for", arguments: { log: { contains: "FIXTURE_RENDERER_FAILURE", process: "renderer" } } },
      { tool: "electron_logs", arguments: { process: "renderer" } },
      { tool: "electron_dom_snapshot" },
    ],
  },

  "main-window": {
    summary: "Window never appears: the cause is on the main side",
    fixture: { fault: "main-window" },
    tools: ["electron_attach", "electron_logs", "electron_status", "electron_wait_for"],
    prompt: `${boundary}
The developer says the app starts but no window ever appears. Attach and work out which side is responsible: check
which channels are online and read the logs of the right process. State whether the cause is in the main process or the
renderer, and quote the evidence.`,
    verify(calls) {
      requireTools(calls, ["electron_attach", "electron_logs"]);
      assert.ok(succeeded(calls, "electron_attach", (data) => data.main?.online && !data.renderer?.online).length,
        "attach should show the main channel online and the renderer channel offline");
      assert.ok(succeeded(calls, "electron_logs", (data) => hasExpectedEvidence(data.events, "main-window")).length,
        "host never received the main-process window failure");
    },
    reference: [
      { tool: "electron_attach" },
      { tool: "electron_wait_for", arguments: { log: { contains: "FIXTURE_MAIN_WINDOW_FAILURE", process: "main" } } },
      { tool: "electron_logs", arguments: { process: "main" } },
    ],
  },

  inspect: {
    summary: "Healthy app: prove it with a wait, a main-process check, a page snapshot and a screenshot",
    fixture: {},
    tools: ["electron_attach", "electron_wait_for", "electron_evaluate", "electron_dom_snapshot",
      "electron_screenshot", "electron_logs"],
    prompt: `${boundary}
Check that the fixture app is healthy and give runtime evidence for each point, using a different tool for each:
1. Wait until the page is ready: the element with id "result" must show the text fixture-ok (use electron_wait_for
   with an expression, not a fixed delay).
2. Ask the main process how many BrowserWindow instances exist (electron_evaluate with scope main).
3. Read the page content through the accessibility snapshot.
4. Take one screenshot and report the saved file path.
5. Confirm the logs contain no error-level events.
Finish with PASS, FAIL or BLOCKED and the evidence.`,
    verify(calls) {
      requireTools(calls, ["electron_attach", "electron_wait_for", "electron_evaluate", "electron_dom_snapshot",
        "electron_screenshot", "electron_logs"]);
      assert.ok(succeeded(calls, "electron_attach", bothOnline).length, "attach did not return two live sessions");
      assert.ok(succeeded(calls, "electron_wait_for", (data) => data.matched === true).length,
        "no wait_for condition was actually satisfied");
      assert.ok(succeeded(calls, "electron_evaluate", (data, args) => args.scope === "main" && data.scope === "main").length,
        "no successful evaluation ran in the main process");
      assert.ok(succeeded(calls, "electron_dom_snapshot", (data) => /fixture-ok/u.test(data.text)).length,
        "the snapshot never showed the fixture result");
      assert.ok(succeeded(calls, "electron_screenshot", (data) => typeof data.path === "string" && data.bytes > 0).length,
        "no screenshot was saved");
      assert.ok(succeeded(calls, "electron_logs").length, "the logs were never read");
    },
    reference: [
      { tool: "electron_attach" },
      {
        tool: "electron_wait_for",
        arguments: { expression: { scope: "renderer", expression: "document.querySelector('#result')?.textContent === 'fixture-ok'" } },
      },
      {
        tool: "electron_evaluate",
        arguments: { scope: "main", expression: "process.mainModule.require('electron').BrowserWindow.getAllWindows().length" },
      },
      { tool: "electron_dom_snapshot" },
      { tool: "electron_screenshot" },
      { tool: "electron_logs", arguments: { level: "error" } },
    ],
  },

  utility: {
    summary: "Utility process: attach through the main process and read its state",
    fixture: { utility: true },
    tools: ["electron_attach", "electron_evaluate", "electron_logs", "electron_status"],
    prompt: `${boundary}
The app forks a utility process with serviceName fixture-utility. Attach to it (electron_attach has a utility
argument; you do not need its pid or any port) and read the value of globalThis.fixtureUtility.value inside that
process with electron_evaluate. Report the value and which channels were online.`,
    verify(calls) {
      requireTools(calls, ["electron_attach", "electron_evaluate"]);
      assert.ok(succeeded(calls, "electron_attach", (data, args) =>
        data.utility?.online && data.main?.online && args.utility !== undefined).length,
      "attach never brought the utility channel online next to main");
      assert.ok(succeeded(calls, "electron_evaluate", (data, args) =>
        args.scope === "utility" && data.value === "utility-ok").length,
      "the utility value was never read from the utility process");
    },
    reference: [
      { tool: "electron_attach", arguments: { utility: "fixture-utility" } },
      { tool: "electron_evaluate", arguments: { scope: "utility", expression: "globalThis.fixtureUtility.value" } },
    ],
  },
  "devtools-windows": {
    summary: "Development build: DevTools and two windows are open, pick the right window and read it",
    fixture: { app: "field" },
    tools: ["electron_attach", "electron_targets", "electron_dom_snapshot", "electron_evaluate", "electron_status"],
    prompt: `${boundary}
This is a development build, so DevTools is open and the app has two windows, "Field App" and "Field Settings".
The developer wants the "Field App" window checked. Attach, make sure the tools are connected to that window (not to
Settings and not to DevTools), read the page with the accessibility snapshot and report its main heading, and ask the
main process how many BrowserWindow instances exist. Report the heading, the count, and how you chose the window.`,
    verify(calls) {
      requireTools(calls, ["electron_attach", "electron_dom_snapshot", "electron_evaluate"]);
      assert.ok(succeeded(calls, "electron_attach", (data) => data.main?.online).length, "attach never reached the main process");
      const selected = succeeded(calls, "electron_targets", (data) => data.selectedTarget?.title === "Field App").length +
        succeeded(calls, "electron_attach", (data) => data.selectedTarget?.title === "Field App").length;
      assert.ok(selected > 0, "the tools were never connected to the Field App window");
      assert.ok(succeeded(calls, "electron_dom_snapshot", (data) => /heading "Field App"/u.test(data.text)).length,
        "the snapshot never showed the Field App window");
      assert.ok(succeeded(calls, "electron_evaluate", (data, args) => args.scope === "main" && data.scope === "main").length,
        "the main process was never asked about its windows");
    },
    reference: [
      { tool: "electron_attach" },
      { tool: "electron_targets", arguments: { title: "Field App" } },
      { tool: "electron_dom_snapshot" },
      {
        tool: "electron_evaluate",
        arguments: { scope: "main", expression: "process.mainModule.require('electron').BrowserWindow.getAllWindows().length" },
      },
    ],
  },

  "click-save": {
    summary: "Nothing happens until a button is pressed: press it and read what happens on both sides",
    fixture: { app: "field", fault: "save" },
    tools: ["electron_attach", "electron_targets", "electron_evaluate", "electron_wait_for", "electron_logs",
      "electron_dom_snapshot", "electron_status"],
    prompt: `${boundary}
This is a development build with DevTools open and two windows, "Field App" and "Field Settings". The developer changed
the Save button handler in "Field App" and wants to know whether saving works. Nothing happens until the button is
pressed, so press it yourself, using only the electron-debug tools. Then read the evidence from both sides: the
renderer's console and what the page shows, and the main process's console. Report PASS, FAIL or BLOCKED with the
evidence you saw.`,
    verify(calls) {
      requireTools(calls, ["electron_attach", "electron_evaluate"]);
      assert.ok(succeeded(calls, "electron_evaluate", (data, args) => args.scope === "renderer" && data.scope === "renderer").length,
        "nothing was evaluated in the renderer, so the button cannot have been pressed");
      const events = [
        ...succeeded(calls, "electron_logs").flatMap((call) => call.result.data.events),
        ...succeeded(calls, "electron_wait_for", (data) => data.event).map((call) => call.result.data.event),
      ];
      const seen = (process, text) => events.some((event) => event.process === process && event.message.includes(text));
      assert.ok(seen("renderer", "FIELD_SAVE_CALL_FAILURE"), "the renderer's failed save call was never read");
      assert.ok(seen("main", "FIELD_SAVE_HANDLER_FAILURE"), "the main process's failing handler was never read");
    },
    reference: [
      { tool: "electron_attach" },
      { tool: "electron_targets", arguments: { title: "Field App" } },
      { tool: "electron_evaluate", arguments: { scope: "renderer", expression: "document.querySelector('#save').click(); true" } },
      { tool: "electron_wait_for", arguments: { log: { contains: "FIELD_SAVE_CALL_FAILURE", process: "renderer" } } },
      { tool: "electron_wait_for", arguments: { log: { contains: "FIELD_SAVE_HANDLER_FAILURE", process: "main" } } },
      { tool: "electron_logs", arguments: { process: "all", sinceAttach: true } },
    ],
  },
};

export const scenarioNames = Object.keys(scenarios);
