import assert from "node:assert/strict";
import test from "node:test";
import { scenarioNames, scenarios as untypedScenarios } from "../examples/host-e2e/scenarios.mjs";

interface Call { name: string; args: Record<string, unknown>; result: { ok: boolean; data: Record<string, unknown> } }
interface Scenario {
  prompt: string;
  tools: string[];
  app: Record<string, unknown>;
  reference: Array<{ tool: string }>;
  verify(calls: Call[]): void;
}
const scenarios = untypedScenarios as Record<string, Scenario>;

// The scenarios judge a real host by MCP traffic alone. The reference replays (examples/host-e2e/reference.mjs) show
// that a correct run passes against the real app; these checks need no Electron.
test("every scenario rejects a run that called no tools", () => {
  for (const name of scenarioNames) {
    rejects(() => scenarios[name].verify([]), /never invoked electron_attach/u, `${name} accepted an empty trace`);
  }
});

test("every scenario carries a reference solution, a prompt that names its task and an app setup", () => {
  for (const name of scenarioNames) {
    const scenario = scenarios[name];
    assert.ok(scenario.reference.length > 0, `${name} has no reference solution`);
    assert.ok(scenario.prompt.length > 100, `${name} has no prompt`);
    assert.ok(scenario.app && typeof scenario.app === "object", `${name} does not say how to start the app`);
    for (const step of scenario.reference) {
      assert.ok(scenario.tools.includes(step.tool) || step.tool === "electron_wait_for" || step.tool === "electron_status",
        `${name}: the reference uses ${step.tool}, which the scenario does not list`);
    }
  }
});

// Synthetic traffic in the shape the server answers with. Each case pairs a run that must pass, which shows the
// synthetic evidence is of the right shape, with runs that must not: the wrong evidence, evidence from the wrong side,
// evidence from before the press, and a press that was not made with electron_click.
// The verification must refuse for the stated reason, not for an unrelated failure of the synthetic trace.
const rejects = (run: () => void, reason: RegExp, label: string) =>
  assert.throws(run, (error: unknown) => error instanceof assert.AssertionError && reason.test(error.message), label);
const call = (name: string, args: Record<string, unknown>, data: Record<string, unknown>): Call => ({ name, args, result: { ok: true, data } });
const event = (seq: number, process: string, kind: string, level: string, message: string, data?: unknown) =>
  ({ seq, process, kind, level, message, data });
const logs = (...events: unknown[]) => call("electron_logs", {}, { events });
const board = { title: "Task Board", url: "http://localhost:5173/#/" };
const online = { main: { online: true }, renderer: { online: true }, selectedTarget: board };
const press = (label: string, afterSeq: number) => call("electron_click", { role: "button", name: label }, { role: "button", name: label, afterSeq });
const snapshot = (open: number, total: number, rows: number) => call("electron_dom_snapshot", {}, {
  text: `paragraph\n  StaticText "${open} open of ${total}"\nlist\n${"  listitem [level=1]\n".repeat(rows)}`,
});

const rendererRefused = event(7, "renderer", "exception", "error",
  "Uncaught (in promise) Error: Error invoking remote method 'tasks:add': Error: No handler registered for 'tasks:add'");
const mainRefused = event(6, "main", "console", "error", "Error occurred in handler for 'tasks:add': Error: No handler registered for 'tasks:add'");
const attach = call("electron_attach", {}, online);

test("click-add needs the press and both sides' evidence from after it", () => {
  const { verify } = scenarios["click-add"];
  verify([attach, press("Add", 4), logs(mainRefused, rendererRefused)]);
  rejects(() => verify([attach, press("Add", 4), logs(rendererRefused)]), /main process's report/u, "main side missing");
  rejects(() => verify([attach, press("Add", 4), logs({ ...mainRefused, process: "renderer" }, rendererRefused)]), /main process's report/u, "the main process's message was attributed to the renderer");
  rejects(() => verify([attach, press("Add", 9), logs(mainRefused, rendererRefused)]), /renderer's failed add call/u, "evidence from before the press");
  rejects(() => verify([attach, logs(mainRefused, rendererRefused)]), /never invoked electron_click/u, "never pressed");
  rejects(() => verify([attach, press("Add", 4), logs(mainRefused, rendererRefused),
    call("electron_evaluate", { scope: "renderer", expression: "document.querySelector('button').click()" }, { scope: "renderer" })]), /evaluated code/u, "pressed from evaluated code");
  rejects(() => verify([attach, press("Sync", 4), logs(mainRefused, rendererRefused)]), /Add button was never pressed/u, "wrong button");
});

test("stale-add accepts only evidence read after a new press", () => {
  const { verify } = scenarios["stale-add"];
  verify([attach, press("Add", 8), snapshot(2, 3, 3)]);
  verify([attach, press("Add", 8), logs(event(9, "main", "ipc", "info", "IPC invoke tasks:add ok", { channel: "tasks:add", ok: true }))]);
  rejects(() => verify([attach, snapshot(2, 3, 3), press("Add", 8)]), /after the press shows the add working/u, "page read before the press");
  rejects(() => verify([attach, press("Add", 8), snapshot(1, 2, 2)]), /after the press shows the add working/u, "list unchanged");
  rejects(() => verify([attach, press("Add", 8), snapshot(2, 3, 2)]), /after the press shows the add working/u, "row missing");
  rejects(() => verify([attach, press("Add", 8), logs(event(2, "main", "console", "error", "tasks:add failed: disk full"),
    event(6, "renderer", "exception", "error", "Error invoking remote method 'tasks:add': Error: disk full"))]), /after the press shows the add working/u, "the replayed old failure is not evidence of success");
  rejects(() => verify([attach, press("Add", 8), logs(event(5, "main", "ipc", "info", "IPC invoke tasks:add ok", { channel: "tasks:add", ok: true }))]), /after the press shows the add working/u, "traced call from before the press");
});

test("sync-mismatch needs the no-listener IPC event after the press", () => {
  const { verify } = scenarios["sync-mismatch"];
  const unheard = (seq: number, channel = "sync:start", listeners = 0) =>
    event(seq, "main", "ipc", "warn", `IPC send ${channel}`, { type: "send", channel, listeners });
  verify([attach, press("Sync", 6), logs(unheard(7))]);
  rejects(() => verify([attach, press("Sync", 6), logs(unheard(7, "sync-start"))]), /had no listener/u, "another channel");
  rejects(() => verify([attach, press("Sync", 6), logs(unheard(7, "sync:start", 1))]), /had no listener/u, "it had a listener");
  rejects(() => verify([attach, press("Sync", 6), logs(unheard(3))]), /had no listener/u, "event from before the press");
  rejects(() => verify([attach, logs(unheard(7))]), /never invoked electron_click/u, "never pressed");
});

test("renderer needs the exception and the page after the press", () => {
  const { verify } = scenarios.renderer;
  const exception = event(8, "renderer", "exception", "error", "Uncaught (in promise) TypeError: Cannot read properties of undefined (reading 'name')");
  const warning = event(5, "renderer", "console", "warning", "[Vue warn]: Unhandled error during execution of render function");
  verify([attach, press("Add", 4), logs(warning, exception), snapshot(2, 3, 2)]);
  rejects(() => verify([attach, press("Add", 4), logs(warning, exception), snapshot(1, 2, 2)]), /counter and the listed rows disagree/u, "page looks fine");
  rejects(() => verify([attach, snapshot(2, 3, 2), press("Add", 4), logs(warning, exception)]), /counter and the listed rows disagree/u, "page read before the press");
  rejects(() => verify([attach, press("Add", 4), logs(warning, { ...exception, process: "main" }), snapshot(2, 3, 2)]), /renderer exception/u, "exception attributed to main");
  rejects(() => verify([attach, press("Add", 9), logs(warning, exception), snapshot(2, 3, 2)]), /renderer exception/u, "exception from before the press");
});

test("ipc, main-window, utility and devtools-windows reject the wrong side or the wrong target", () => {
  const status = call("electron_status", {}, online);
  const targets = call("electron_targets", {}, { targets: [board], selectedTarget: board });
  const handler = event(5, "main", "console", "error", "Error occurred in handler for 'tasks:list': SyntaxError: Unexpected token");
  const loadFailed = event(6, "renderer", "console", "error", "load tasks failed Error");
  scenarios.ipc.verify([attach, status, targets, logs(handler, loadFailed)]);
  rejects(() => scenarios.ipc.verify([attach, status, targets, logs({ ...handler, process: "renderer" }, loadFailed)]), /main process's error/u, "swapped sides");
  rejects(() => scenarios.ipc.verify([attach, status, targets, logs(handler)]), /renderer's own load error/u, "renderer side missing");

  const windowless = call("electron_attach", {}, { main: { online: true }, renderer: { online: false } });
  const noWindow = event(1, "main", "console", "error", "Could not create the main window SyntaxError: Expected property name");
  scenarios["main-window"].verify([windowless, logs(noWindow)]);
  rejects(() => scenarios["main-window"].verify([attach, logs(noWindow)]), /renderer channel offline/u, "renderer was online");
  rejects(() => scenarios["main-window"].verify([windowless, logs({ ...noWindow, process: "renderer" })]), /main-process window failure/u, "wrong side");

  const utility = call("electron_attach", { utility: "task-indexer" }, { ...online, utility: { online: true } });
  const size = (scope: string, value: number) => call("electron_evaluate", { scope, expression: "indexer.size()" }, { scope, value });
  scenarios.utility.verify([utility, size("utility", 2)]);
  rejects(() => scenarios.utility.verify([attach, size("utility", 2)]), /utility channel online/u, "utility never attached");
  rejects(() => scenarios.utility.verify([utility, size("main", 2)]), /inside the utility process/u, "read in the wrong process");
  rejects(() => scenarios.utility.verify([utility, size("utility", 3)]), /inside the utility process/u, "wrong value");

  const heading = call("electron_dom_snapshot", {}, { text: 'heading "Tasks" [level=1]' });
  const windows = (value: number) => call("electron_evaluate", { scope: "main", expression: "getAllWindows().length" }, { scope: "main", value });
  const chose = (selectedTarget: unknown) => call("electron_targets", { title: "x" }, { targets: [], selectedTarget });
  const devtools = { main: { online: true }, renderer: { online: false } };
  scenarios["devtools-windows"].verify([call("electron_attach", {}, devtools), chose(board), heading, windows(2)]);
  rejects(() => scenarios["devtools-windows"].verify([call("electron_attach", {}, devtools),
    chose({ title: "Settings - Task Board", url: "http://localhost:5173/#/settings" }), heading, windows(2)]), /never connected to the Task Board window/u, "settings window chosen");
  rejects(() => scenarios["devtools-windows"].verify([call("electron_attach", {}, devtools), chose(board),
    call("electron_dom_snapshot", {}, { text: 'heading "Settings" [level=1]' }), windows(2)]), /never showed the Task Board window/u, "snapshot of another window");
  rejects(() => scenarios["devtools-windows"].verify([call("electron_attach", {}, devtools), chose(board), heading, windows(3)]), /two windows/u, "DevTools counted as a window");
});
