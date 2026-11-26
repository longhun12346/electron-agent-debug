import assert from "node:assert/strict";
import { McpClient } from "../vue-vite-app/support.mjs";
import { startScenarioApp } from "./app-launch.mjs";
import { scenarioNames, scenarios } from "./scenarios.mjs";

// Plays each scenario's scripted reference solution against the real app and applies the same verification the
// host smoke applies to a model. No model is involved, so this runs in CI and proves the scenarios are solvable
// with the shipped tools and that their assertions accept a correct run.
const requested = process.argv.slice(2);
const names = requested.length ? requested : scenarioNames;
for (const name of names) assert.ok(scenarios[name], `unknown scenario: ${name}; available: ${scenarioNames.join(", ")}`);

let requestId = 1;
for (const name of names) {
  const scenario = scenarios[name];
  const running = await startScenarioApp(scenario);
  const client = new McpClient(running.endpoints);
  try {
    await client.request(requestId++, "initialize", {
      protocolVersion: "2025-03-26", capabilities: {},
      clientInfo: { name: "host-e2e-reference", version: "1.0.0" },
    });
    client.notify("notifications/initialized", {});
    const calls = [];
    for (const step of scenario.reference) {
      // A step's arguments may depend on earlier results (the afterSeq of a click).
      const args = (typeof step.arguments === "function" ? step.arguments(calls) : step.arguments) ?? {};
      const response = await client.request(requestId++, "tools/call", { name: step.tool, arguments: args }, 30_000)
        .catch((error) => { throw new Error(`reference step ${step.tool} of ${name}: ${error.message}`); });
      // A reference step that fails is a broken scenario, not a run to judge.
      assert.ok(response.result?.structuredContent?.ok, `reference step ${step.tool} failed: ${JSON.stringify(response)}`);
      calls.push({ name: step.tool, args, result: response.result.structuredContent });
    }
    scenario.verify(calls);
    console.log(JSON.stringify({ scenario: name, tools: calls.map((call) => call.name), result: "PASS" }));
  } finally {
    await client.close();
    await running.stop();
  }
}
