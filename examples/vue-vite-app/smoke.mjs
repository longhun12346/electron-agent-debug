import assert from "node:assert/strict";

// Runs the scenarios of the Vue + Vite example. With no arguments, all of them; otherwise the names given.
const modules = ["workflow", "faults", "process", "lifecycle", "inspection", "interaction"];
const scenarios = {};
for (const name of modules) {
  const loaded = await import(`./scenarios/${name}.mjs`).catch((error) => {
    if (error.code === "ERR_MODULE_NOT_FOUND" && error.message.includes(`${name}.mjs`)) return undefined;
    throw error;
  });
  if (loaded) Object.assign(scenarios, loaded.scenarios);
}

const names = process.argv.length > 2 ? process.argv.slice(2) : Object.keys(scenarios);
for (const name of names) {
  assert.ok(scenarios[name], `unknown scenario ${name}; known: ${Object.keys(scenarios).join(", ")}`);
  console.log(`Running vue-vite scenario: ${name}`);
  await scenarios[name]();
}
console.log(JSON.stringify({ platform: process.platform, vueVite: "PASS", scenarios: names }));
