import assert from "node:assert/strict";

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

// Every event the host received, from log reads and from waits that matched one.
function eventsRead(calls) {
  return [
    ...succeeded(calls, "electron_logs").flatMap((call) => call.result.data.events),
    ...succeeded(calls, "electron_wait_for", (data) => data.event).map((call) => call.result.data.event),
  ];
}

// Whether one event of `process` carries all the given texts, so a message of the other side cannot stand in for it.
const said = (events, process, ...texts) =>
  events.some((event) => event.process === process && texts.every((text) => String(event.message ?? "").includes(text)));

// A button pressed the way a user presses it: electron_click, whose result names the button it pressed. Evaluated code
// that calls element.click() or submits the form is not a press.
function pressesOf(calls, label) {
  const presses = succeeded(calls, "electron_click", (data) => data.role === "button" && data.name === label);
  assert.ok(presses.length, `the ${label} button was never pressed with electron_click`);
  assert.ok(!calls.some((call) => call.name === "electron_evaluate" && /\.click\s*\(|requestSubmit/u.test(String(call.args.expression ?? ""))),
    "the button was pressed from evaluated code instead of electron_click");
  return presses;
}

// Events received after the first press, so the history replayed on attach cannot stand in for the result of the press.
function eventsAfter(calls, presses) {
  const pressedAt = Math.min(...presses.map((call) => call.result.data.afterSeq));
  return eventsRead(calls).filter((event) => event.seq > pressedAt);
}

// Accessibility snapshots the host read after its first press, in call order.
function snapshotsAfter(calls, presses) {
  return succeeded(calls.slice(calls.indexOf(presses[0]) + 1), "electron_dom_snapshot").map((call) => call.result.data.text);
}

// What a snapshot of the task board says: the total in the counter ("2 open of 3") and the rows it actually lists.
function boardOf(text) {
  const counter = /(\d+) open of (\d+)/u.exec(text);
  return { total: counter ? Number(counter[2]) : undefined, rows: (text.match(/^\s*listitem\b/gmu) ?? []).length };
}

const bothOnline = (data) => data.main?.online && data.renderer?.online && data.selectedTarget;

// The afterSeq of the latest click, for steps that wait for what the press caused.
const afterPress = (calls) => calls.findLast((call) => call.name === "electron_click").result.data.afterSeq;

const boundary = `This is a bounded MCP host integration test. The test runner has already built the
MCP server and started the app under test, a Vue 3 + Vite task board in development mode, with its main-process
Inspector and CDP port open. Do not configure or launch anything. Only use electron-debug MCP tools, no shell,
files, browser, other servers, or subagents. The endpoints are already configured, so electron_attach needs no
endpoint arguments. Report what you observed, then stop. Do not modify the app.`;

// Each scenario is one task a coding Agent would get. `app` says how the runner starts the Vue app (see app-launch.mjs).
// `verify` judges the real MCP traffic only: it checks that the host chose the right channels and tools and that the
// evidence it received is the app's, never what the model says. `reference` is a scripted run of the same task, so the
// scenario can be checked without a model.
export const scenarios = {
  // The data file is damaged: the page fails while it loads, and each side logged its own error.
  ipc: {
    summary: "IPC failure at page load: evidence from both processes",
    app: { store: "{ not json" },
    tools: ["electron_attach", "electron_status", "electron_targets", "electron_logs", "electron_wait_for"],
    prompt: `${boundary}
The task board opens with an empty list and a banner saying "Could not load tasks". Call electron_attach,
electron_status, electron_targets, and electron_logs (process all, limit 100). Both main and renderer must be online,
with a selected target. The logs must include the main process's error for the failed IPC handler (it names the handler
and the underlying error) and the renderer's own "load tasks failed" error. Retry logs up to 3 times if needed.
Report which handler failed, why, and which process logged which message.`,
    verify(calls) {
      requireTools(calls, ["electron_attach", "electron_status", "electron_targets", "electron_logs"]);
      for (const name of ["electron_attach", "electron_status"]) {
        assert.ok(succeeded(calls, name, bothOnline).length,
          `${name} did not return two live sessions and a selected target`);
      }
      assert.ok(succeeded(calls, "electron_targets", (data) => data.targets.length > 0 && data.selectedTarget).length);
      const events = eventsRead(calls);
      assert.ok(events.some((event) => event.process === "main"
        && /Error occurred in handler for 'tasks:list'[\s\S]*SyntaxError/u.test(String(event.message))),
      "host never received the main process's error for the failing tasks:list handler");
      assert.ok(said(events, "renderer", "load tasks failed"), "host never received the renderer's own load error");
    },
    reference: [
      { tool: "electron_attach" },
      { tool: "electron_status" },
      { tool: "electron_targets" },
      // Each channel has its own connection, so one channel's event can arrive before another's that happened earlier:
      // wait for the evidence of each channel, not for one and then read both.
      { tool: "electron_wait_for", arguments: { log: { contains: "load tasks failed", process: "renderer" } } },
      { tool: "electron_wait_for", arguments: { log: { contains: "Error occurred in handler for 'tasks:list'", process: "main" } } },
      { tool: "electron_logs", arguments: { process: "all", limit: 100 } },
    ],
  },

  // New tasks come back without the field the list renders: the render throws and the row never appears.
  renderer: {
    summary: "Renderer exception after a press: the error text plus what the page shows",
    app: { fault: "missing-field" },
    tools: ["electron_attach", "electron_dom_snapshot", "electron_type", "electron_click", "electron_wait_for", "electron_logs"],
    prompt: `${boundary}
A developer reports that the task board breaks when a task is added: the page stops updating correctly. Nothing
happens until the Add button is pressed, and it does nothing while the "New task" box is empty, so reproduce it
yourself: type a title and press Add. Find out what the renderer reported and what the page shows afterwards. Use the
logs for the error and the accessibility snapshot for the page content; you cannot open image files, so do not rely
on a screenshot. Quote the error text and what the task list shows compared with what its counter says.`,
    verify(calls) {
      requireTools(calls, ["electron_attach", "electron_logs", "electron_dom_snapshot", "electron_click"]);
      assert.ok(succeeded(calls, "electron_attach", (data) => data.renderer?.online).length, "renderer never came online");
      const presses = pressesOf(calls, "Add");
      const events = eventsAfter(calls, presses);
      assert.ok(events.some((event) => event.process === "renderer" && event.kind === "exception"
        && /TypeError/u.test(event.message) && event.message.includes("reading 'name'")),
      "host never received the renderer exception as readable text after the press");
      assert.ok(said(events, "renderer", "[Vue warn]"), "host never read the Vue warning that names the failing component");
      // The counter already counts the new task but its row was never rendered.
      assert.ok(snapshotsAfter(calls, presses).some((text) => {
        const { total, rows } = boardOf(text);
        return total !== undefined && total > rows;
      }), "host never read the page after the failure, where the counter and the listed rows disagree");
    },
    reference: [
      { tool: "electron_attach" },
      { tool: "electron_dom_snapshot" },
      { tool: "electron_type", arguments: { role: "textbox", name: "New task", text: "Ship the demo" } },
      { tool: "electron_click", arguments: { role: "button", name: "Add" } },
      {
        tool: "electron_wait_for",
        arguments: (calls) => ({ log: { contains: "reading 'name'", process: "renderer", afterSeq: afterPress(calls) } }),
      },
      { tool: "electron_logs", arguments: (calls) => ({ process: "renderer", afterSeq: afterPress(calls) }) },
      { tool: "electron_dom_snapshot" },
    ],
  },

  // The window settings file is damaged: the main process is up, but no window is ever created.
  "main-window": {
    summary: "Window never appears: the cause is on the main side",
    app: { files: { "window.json": "{ nope" }, windowless: true },
    tools: ["electron_attach", "electron_logs", "electron_status", "electron_wait_for"],
    prompt: `${boundary}
The developer says the app starts but no window ever appears. Attach and work out which side is responsible: check
which channels are online and read the logs of the right process. State whether the cause is in the main process or the
renderer, and quote the evidence.`,
    verify(calls) {
      requireTools(calls, ["electron_attach", "electron_logs"]);
      assert.ok(succeeded(calls, "electron_attach", (data) => data.main?.online && !data.renderer?.online).length,
        "attach should show the main channel online and the renderer channel offline");
      assert.ok(eventsRead(calls).some((event) => event.process === "main"
        && String(event.message).includes("Could not create the main window") && /SyntaxError/u.test(String(event.message))),
      "host never received the main-process window failure with its cause");
    },
    reference: [
      { tool: "electron_attach" },
      { tool: "electron_wait_for", arguments: { log: { contains: "Could not create the main window", process: "main" } } },
      { tool: "electron_logs", arguments: { process: "main" } },
    ],
  },

  inspect: {
    summary: "Healthy app: prove it with a wait, a main-process check, a page snapshot and a screenshot",
    app: {},
    tools: ["electron_attach", "electron_wait_for", "electron_evaluate", "electron_dom_snapshot",
      "electron_screenshot", "electron_logs"],
    prompt: `${boundary}
Check that the task board is healthy and give runtime evidence for each point, using a different tool for each:
1. Wait until the page is ready: the task list must show its two seeded tasks (use electron_wait_for with an
   expression, not a fixed delay).
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
      assert.ok(succeeded(calls, "electron_evaluate", (data, args) => args.scope === "main" && data.scope === "main" && data.value === 1).length,
        "the main process was never asked, successfully, for its one window");
      assert.ok(succeeded(calls, "electron_dom_snapshot", (data) =>
        /Review the pull request/u.test(data.text) && /1 open of 2/u.test(data.text)).length,
      "the snapshot never showed the seeded task list");
      assert.ok(succeeded(calls, "electron_screenshot", (data) => typeof data.path === "string" && data.bytes > 0).length,
        "no screenshot was saved");
      assert.ok(succeeded(calls, "electron_logs", (data) => !data.events.some((event) => event.level === "error")).length,
        "the logs were never read without error-level events");
    },
    reference: [
      { tool: "electron_attach" },
      {
        tool: "electron_wait_for",
        arguments: { expression: { scope: "renderer", expression: "document.querySelectorAll('li.task').length === 2" } },
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

  // The search index lives in the utility process "task-indexer"; indexer.size() is a global in that process.
  utility: {
    summary: "Utility process: attach through the main process and read its state",
    app: { indexer: true },
    tools: ["electron_attach", "electron_evaluate", "electron_logs", "electron_status"],
    prompt: `${boundary}
The app forks a utility process with serviceName task-indexer that keeps the search index of the task list. Attach to
it (electron_attach has a utility argument; you do not need its pid or any port) and read the value of
indexer.size() inside that process with electron_evaluate. Report the value and which channels were online.`,
    verify(calls) {
      requireTools(calls, ["electron_attach", "electron_evaluate"]);
      assert.ok(succeeded(calls, "electron_attach", (data, args) =>
        data.utility?.online && data.main?.online && args.utility !== undefined).length,
      "attach never brought the utility channel online next to main");
      assert.ok(succeeded(calls, "electron_evaluate", (data, args) =>
        args.scope === "utility" && data.scope === "utility" && data.value === 2).length,
      "the two indexed tasks were never counted inside the utility process");
    },
    reference: [
      { tool: "electron_attach", arguments: { utility: "task-indexer" } },
      { tool: "electron_evaluate", arguments: { scope: "utility", expression: "indexer.size()" } },
    ],
  },

  // A development build: DevTools and a second window are open next to the main window, and the console was noisy.
  "devtools-windows": {
    summary: "Development build: DevTools and two windows are open, pick the right window and read it",
    app: { devtools: true, settingsWindow: true, noise: 800 },
    tools: ["electron_attach", "electron_targets", "electron_dom_snapshot", "electron_evaluate", "electron_status"],
    prompt: `${boundary}
This is a development build, so DevTools is open and the app has two windows: "Task Board" (the task list) and
"Settings - Task Board". The developer wants the "Task Board" window checked. Attach, make sure the tools are
connected to that window (not to the settings window and not to DevTools), read the page with the accessibility
snapshot and report its main heading, and ask the main process how many BrowserWindow instances exist. Report the
heading, the count, and how you chose the window.`,
    verify(calls) {
      requireTools(calls, ["electron_attach", "electron_dom_snapshot", "electron_evaluate"]);
      assert.ok(succeeded(calls, "electron_attach", (data) => data.main?.online).length, "attach never reached the main process");
      const isBoard = (data) => data.selectedTarget?.title === "Task Board" && !/#\/settings/u.test(data.selectedTarget.url);
      assert.ok(succeeded(calls, "electron_targets", isBoard).length + succeeded(calls, "electron_attach", isBoard).length > 0,
        "the tools were never connected to the Task Board window");
      assert.ok(succeeded(calls, "electron_dom_snapshot", (data) => /heading "Tasks"/u.test(data.text)).length,
        "the snapshot never showed the Task Board window");
      assert.ok(succeeded(calls, "electron_evaluate", (data, args) => args.scope === "main" && data.scope === "main" && data.value === 2).length,
        "the main process was never asked about its two windows");
    },
    reference: [
      { tool: "electron_attach" },
      { tool: "electron_targets", arguments: { title: "Task Board" } },
      { tool: "electron_dom_snapshot" },
      {
        tool: "electron_evaluate",
        arguments: { scope: "main", expression: "process.mainModule.require('electron').BrowserWindow.getAllWindows().length" },
      },
    ],
  },

  // The handler for tasks:add is registered under another name, so the call from the page is refused. Nothing happens
  // until a title is typed and Add is pressed, so only a press makes either side log anything.
  "click-add": {
    summary: "Nothing happens until a button is pressed: press it and read what happens on both sides",
    app: { fault: "ipc-channel" },
    tools: ["electron_attach", "electron_dom_snapshot", "electron_type", "electron_click", "electron_wait_for",
      "electron_logs", "electron_evaluate", "electron_status"],
    prompt: `${boundary}
The developer changed the IPC code that adds tasks and wants to know whether adding a task works. Nothing happens
until the Add button is pressed, and pressing it does nothing while the "New task" box is empty, so type a title and
press Add yourself, using only the electron-debug tools. Then read the evidence from both sides: the renderer's
console and what the page shows, and the main process's console. Report PASS, FAIL or BLOCKED with the evidence you
saw.`,
    verify(calls) {
      requireTools(calls, ["electron_attach", "electron_click"]);
      const events = eventsAfter(calls, pressesOf(calls, "Add"));
      // The two sides word the same failure differently, which keeps one side's message from standing in for the other.
      assert.ok(said(events, "renderer", "Error invoking remote method 'tasks:add'", "No handler registered for 'tasks:add'"),
        "the renderer's failed add call after the press was never read");
      assert.ok(said(events, "main", "Error occurred in handler for 'tasks:add'"),
        "the main process's report of the missing handler after the press was never read");
    },
    reference: [
      { tool: "electron_attach" },
      { tool: "electron_dom_snapshot" },
      { tool: "electron_type", arguments: { role: "textbox", name: "New task", text: "Ship the demo" } },
      { tool: "electron_click", arguments: { role: "button", name: "Add" } },
      {
        tool: "electron_wait_for",
        arguments: (calls) => ({ log: { contains: "No handler registered for 'tasks:add'", process: "renderer", afterSeq: afterPress(calls) } }),
      },
      {
        tool: "electron_wait_for",
        arguments: (calls) => ({ log: { contains: "Error occurred in handler for 'tasks:add'", process: "main", afterSeq: afterPress(calls) } }),
      },
      { tool: "electron_logs", arguments: { process: "all", sinceAttach: true } },
    ],
  },

  // The first add failed ("disk full") before the developer fixed it. The runner reproduces that before the host attaches,
  // so attaching replays the old failure and the box still holds the rejected title. Only a press made now shows that
  // adding works: the second add succeeds, and a success logs nothing.
  "stale-add": {
    summary: "A fixed handler: old failure in the history, only a new press tells the truth",
    app: {
      fault: "stale-add",
      before: [
        { tool: "electron_type", arguments: { role: "textbox", name: "New task", text: "First try" } },
        { tool: "electron_click", arguments: { role: "button", name: "Add" } },
        { tool: "electron_wait_for", arguments: { log: { contains: "tasks:add failed: disk full", process: "main" } } },
      ],
    },
    tools: ["electron_attach", "electron_dom_snapshot", "electron_click", "electron_type", "electron_wait_for",
      "electron_logs", "electron_evaluate", "electron_status"],
    prompt: `${boundary}
The developer says they have just fixed the code that adds tasks, which used to fail with an error, and asks whether
adding a task works now. The "New task" box may still hold the title of their last attempt. Use only the electron-debug
tools and read the page with the accessibility snapshot. Report PASS, FAIL or BLOCKED with the evidence you saw.`,
    verify(calls) {
      requireTools(calls, ["electron_attach", "electron_click"]);
      const presses = pressesOf(calls, "Add");
      // A success logs nothing unless the IPC trace is on, so the proof is the page after the press (the counter, and the
      // new row listed) or the traced add call that finished ok. The failure replayed on attach proves nothing.
      const page = snapshotsAfter(calls, presses).some((text) => {
        const { total, rows } = boardOf(text);
        return total === 3 && rows === 3;
      });
      const traced = eventsAfter(calls, presses).some((event) =>
        event.kind === "ipc" && event.data?.channel === "tasks:add" && event.data?.ok === true);
      assert.ok(page || traced, "nothing read after the press shows the add working: neither the three listed tasks nor a successful traced call");
    },
    reference: [
      { tool: "electron_attach" },
      { tool: "electron_dom_snapshot" },
      { tool: "electron_click", arguments: { role: "button", name: "Add" } },
      { tool: "electron_wait_for", arguments: { expression: { scope: "renderer", expression: "document.querySelectorAll('li.task').length === 3" } } },
      { tool: "electron_dom_snapshot" },
      { tool: "electron_logs", arguments: { process: "all", sinceAttach: true } },
    ],
  },

  // Nothing is thrown or logged: the page sends "sync:start" and the main process listens on another name. Only the IPC
  // trace of the main process says the message had no listener.
  "sync-mismatch": {
    summary: "A button that does nothing: the message has no listener, visible only in the IPC trace",
    app: { fault: "silent-send" },
    tools: ["electron_attach", "electron_dom_snapshot", "electron_click", "electron_wait_for",
      "electron_logs", "electron_evaluate", "electron_status"],
    prompt: `${boundary}
The developer reports that pressing the Sync button on the task board does nothing: no error, and "Last sync" stays
"never". Find out why, using only the electron-debug tools. Report the cause and the evidence you saw.`,
    verify(calls) {
      requireTools(calls, ["electron_attach", "electron_click"]);
      const events = eventsAfter(calls, pressesOf(calls, "Sync"));
      assert.ok(events.some((event) => event.kind === "ipc" && event.data?.channel === "sync:start" && event.data?.listeners === 0),
        "the IPC event showing sync:start had no listener was never read");
    },
    reference: [
      { tool: "electron_attach", arguments: { instrument: ["ipc"] } },
      { tool: "electron_dom_snapshot" },
      { tool: "electron_click", arguments: { role: "button", name: "Sync" } },
      {
        tool: "electron_wait_for",
        arguments: (calls) => ({ log: { contains: "sync:start", process: "main", afterSeq: afterPress(calls) } }),
      },
      { tool: "electron_logs", arguments: { process: "all", sinceAttach: true } },
    ],
  },
};

export const scenarioNames = Object.keys(scenarios);
