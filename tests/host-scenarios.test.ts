import assert from "node:assert/strict";
import test from "node:test";
import { scenarioNames, scenarios as untypedScenarios } from "../examples/host-e2e/scenarios.mjs";

interface Scenario {
  prompt: string;
  tools: string[];
  reference: Array<{ tool: string }>;
  verify(calls: unknown[]): void;
}
const scenarios = untypedScenarios as Record<string, Scenario>;

// The scenarios judge a real host by MCP traffic alone. The reference replays (examples/host-e2e/reference.mjs) show
// that a correct run passes; these two checks cover the rest that needs no Electron.
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
