import assert from "node:assert/strict";
import test from "node:test";
import { callsFromTraffic, scenarioNames, scenarios as untypedScenarios } from "../examples/host-e2e/scenarios.mjs";

interface Scenario {
  prompt: string;
  tools: string[];
  reference: Array<{ tool: string }>;
  verify(calls: unknown[]): void;
}
const scenarios = untypedScenarios as Record<string, Scenario>;

// The scenarios judge a real host by MCP traffic alone, so their assertions must reject a run that merely sounds right.
const ok = (name: string, args: Record<string, unknown>, data: unknown) =>
  ({ name, args, result: { ok: true, data } });
const event = (process: string, message: string) => ({ process, message, kind: "console", level: "error" });

test("every scenario rejects a run that called no tools", () => {
  for (const name of scenarioNames) {
    assert.throws(() => scenarios[name].verify([]), assert.AssertionError, `${name} accepted an empty trace`);
  }
});

test("every scenario carries a reference solution and a prompt that names its task", () => {
  for (const name of scenarioNames) {
    const scenario = scenarios[name];
    assert.ok(scenario.reference.length > 0, `${name} has no reference solution`);
    assert.ok(scenario.prompt.length > 100, `${name} has no prompt`);
    for (const step of scenario.reference) {
      assert.ok(scenario.tools.includes(step.tool) || step.tool === "electron_wait_for" || step.tool === "electron_status",
        `${name}: the reference uses ${step.tool}, which the scenario does not list`);
    }
  }
});

test("devtools-windows needs the Field App window, not Settings or DevTools", () => {
  const attach = ok("electron_attach", {}, { main: { online: true }, renderer: { online: false } });
  const evaluateMain = ok("electron_evaluate", { scope: "main" }, { scope: "main", value: 2 });
  const good = [
    attach,
    ok("electron_targets", { title: "Field App" }, { selectedTarget: { title: "Field App" } }),
    ok("electron_dom_snapshot", {}, { text: 'RootWebArea "Field App"\n  heading "Field App"' }),
    evaluateMain,
  ];
  scenarios["devtools-windows"].verify(good);

  const wrongWindow = [
    attach,
    ok("electron_targets", { title: "Field Settings" }, { selectedTarget: { title: "Field Settings" } }),
    ok("electron_dom_snapshot", {}, { text: 'heading "Field Settings"' }),
    evaluateMain,
  ];
  assert.throws(() => scenarios["devtools-windows"].verify(wrongWindow));
  assert.throws(() => scenarios["devtools-windows"].verify(good.slice(0, 3)), assert.AssertionError, "the window count was never asked");
});

test("click-save needs a trusted press of Save and the evidence from both processes after it", () => {
  const verify = scenarios["click-save"].verify;
  const attach = ok("electron_attach", {}, { main: { online: true }, renderer: { online: true } });
  const snapshot = ok("electron_dom_snapshot", {}, { text: 'button "Save" [invalid=false] [ref=abc2]\nbutton "Probe" [ref=abc3]' });
  const press = ok("electron_click", { ref: "abc2" }, { ref: "abc2", afterSeq: 10 });
  const at = (seq: number, process: string, message: string) => ({ ...event(process, message), seq });
  const bothSides = ok("electron_logs", {}, {
    events: [at(11, "renderer", "FIELD_SAVE_CALL_FAILURE Error"), at(12, "main", "FIELD_SAVE_HANDLER_FAILURE")],
  });
  verify([attach, snapshot, press, bothSides]);

  const viaWait = [
    attach, snapshot, press,
    ok("electron_wait_for", {}, { matched: true, event: at(11, "renderer", "FIELD_SAVE_CALL_FAILURE Error") }),
    ok("electron_wait_for", {}, { matched: true, event: at(12, "main", "FIELD_SAVE_HANDLER_FAILURE") }),
  ];
  verify(viaWait);

  const rendererOnly = ok("electron_logs", {}, { events: [at(11, "renderer", "FIELD_SAVE_CALL_FAILURE Error")] });
  assert.throws(() => verify([attach, snapshot, press, rendererOnly]), assert.AssertionError, "main evidence is required");
  assert.throws(() => verify([attach, snapshot, bothSides]), assert.AssertionError, "the button must have been pressed");
  const swapped = ok("electron_logs", {}, {
    events: [at(11, "main", "FIELD_SAVE_CALL_FAILURE Error"), at(12, "renderer", "FIELD_SAVE_HANDLER_FAILURE")],
  });
  assert.throws(() => verify([attach, snapshot, press, swapped]), assert.AssertionError, "channels must not be swapped");

  const evaluated = ok("electron_evaluate", { scope: "renderer", expression: "document.querySelector('#save').click()" },
    { scope: "renderer", value: true });
  assert.throws(() => verify([attach, snapshot, evaluated, bothSides]), assert.AssertionError, "element.click() is not a press");
  assert.throws(() => verify([attach, snapshot, press, evaluated, bothSides]), assert.AssertionError,
    "a click from evaluated code is rejected even next to a real one");
  const otherButton = ok("electron_click", { ref: "abc3" }, { ref: "abc3", afterSeq: 10 });
  assert.throws(() => verify([attach, snapshot, otherButton, bothSides]), assert.AssertionError, "the press must hit Save");
  const byName = ok("electron_click", { role: "button", name: "Save" }, { role: "button", name: "Save", afterSeq: 10 });
  verify([attach, byName, bothSides]);
  const byNameOther = ok("electron_click", { role: "button", name: "Probe" }, { role: "button", name: "Probe", afterSeq: 10 });
  assert.throws(() => verify([attach, byNameOther, bothSides]), assert.AssertionError, "a press by name must hit Save");
  const stale = ok("electron_logs", {}, {
    events: [at(4, "renderer", "FIELD_SAVE_CALL_FAILURE Error"), at(5, "main", "FIELD_SAVE_HANDLER_FAILURE")],
  });
  assert.throws(() => verify([attach, snapshot, press, stale]), assert.AssertionError, "evidence from before the press does not count");
});

test("callsFromTraffic pairs each tools/call with its structured result", () => {
  const calls = callsFromTraffic([
    { direction: "request", message: { id: 1, method: "initialize", params: {} } },
    { direction: "request", message: { id: 2, method: "tools/call", params: { name: "electron_logs", arguments: { limit: 5 } } } },
    { direction: "response", message: { id: 2, result: { structuredContent: { ok: true, data: { events: [] } } } } },
    { direction: "request", message: { id: 3, method: "tools/call", params: { name: "electron_status" } } },
  ]);
  assert.deepEqual(calls.map((call: { name: string }) => call.name), ["electron_logs", "electron_status"]);
  assert.deepEqual(calls[0].args, { limit: 5 });
  assert.equal(calls[0].result.ok, true);
  assert.equal(calls[1].result, undefined, "a call without a response has no result");
});
