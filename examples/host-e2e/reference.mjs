import assert from "node:assert/strict";
import { McpClient } from "../fixture/test-support.mjs";
import { startFixture } from "./fixture-launch.mjs";
import { scenarioNames, scenarios } from "./scenarios.mjs";

// Plays each scenario's scripted reference solution against the real fixture and applies the same verification the
// host smoke applies to a model. No model is involved, so this runs in CI and proves the scenarios are solvable
// with the shipped tools and that their assertions accept a correct run.
const requested = process.argv.slice(2);
const names = requested.length ? requested : scenarioNames;
for (const name of names) assert.ok(scenarios[name], `unknown scenario: ${name}; available: ${scenarioNames.join(", ")}`);

let requestId = 1;
for (const name of names) {
  const scenario = scenarios[name];
  const fixture = await startFixture(scenario);
  const client = new McpClient(fixture.endpoints);
  try {
    await client.request(requestId++, "initialize", {
      protocolVersion: "2025-03-26", capabilities: {},
      clientInfo: { name: "host-e2e-reference", version: "1.0.0" },
    });
    client.notify("notifications/initialized", {});
    const calls = [];
    for (const step of scenario.reference) {
      // A step's arguments may depend on earlier results (a snapshot ref, the afterSeq of a click).
      // `before` plays what a host does outside the tools (starting the app); its result reaches the arguments.
      const context = step.before ? await step.before(fixture) : undefined;
      const args = (typeof step.arguments === "function" ? step.arguments(calls, context) : step.arguments) ?? {};
      const response = await client.request(requestId++, "tools/call", { name: step.tool, arguments: args }, 30_000);
      calls.push({ name: step.tool, args, result: response.result?.structuredContent });
    }
    scenario.verify(calls);
    console.log(JSON.stringify({ scenario: name, tools: calls.map((call) => call.name), result: "PASS" }));
  } finally {
    await client.close();
    await fixture.stop();
  }
}
