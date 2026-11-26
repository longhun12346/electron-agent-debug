import { McpClient, discovery, freePort, startApp, structuredData, waitUntil } from "../vue-vite-app/support.mjs";

// Runs tool calls in a throwaway MCP session of the runner, never through the host's relay, and closes it. A scenario
// uses it to put the app into the state its task starts from (for example one failed press before the host attaches).
async function runBefore(endpoints, steps) {
  const client = new McpClient(endpoints);
  let id = 1;
  try {
    await client.request(id++, "initialize", {
      protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "host-e2e-setup", version: "1.0.0" },
    });
    client.notify("notifications/initialized", {});
    for (const step of steps) {
      const response = await client.request(id++, "tools/call", { name: step.tool, arguments: step.arguments ?? {} }, 30_000)
        .catch((error) => { throw new Error(`setup step ${step.tool}: ${error.message}`); });
      structuredData(response, `setup step ${step.tool}`);
    }
  } finally {
    await client.close();
  }
}

const loaded = [
  { tool: "electron_attach" },
  { tool: "electron_wait_for", arguments: { expression: { scope: "renderer", expression: "document.querySelector('#app')?.childElementCount > 0" }, timeoutMs: 30_000 } },
];

// Starts the Vue + Vite task board the way a scenario asks for and waits until its debug endpoints answer. `scenario.app`:
//   fault, store, files, windowless, noise  as startApp takes them (see examples/vue-vite-app/support.mjs)
//   indexer         true: open the inspector of the task-indexer utility process on a fresh port
//   devtools        true: DevTools next to the main window, as dev builds do
//   settingsWindow  true: a second window titled "Settings - Task Board"
//   before          tool calls (`{ tool, arguments }`) the runner makes, after the page has loaded, in a session of its own
//                   before the host attaches
// The app runs under the electron-vite dev server; the debug ports are dynamic.
export async function startScenarioApp(scenario) {
  const { fault, store, files, windowless, noise, indexer, devtools, settingsWindow, before } = scenario.app ?? {};
  const env = {};
  if (devtools) env.APP_DEVTOOLS = "true";
  if (settingsWindow) env.APP_OPEN_SETTINGS = "true";
  const app = await startApp({
    fault, store, files, windowless, noise, env,
    indexerPort: indexer ? await freePort() : undefined,
  });
  const endpoints = { ELECTRON_DEBUG_MAIN_URL: app.mainUrl, ELECTRON_DEBUG_CDP_URL: app.rendererUrl };
  try {
    // startApp returns once one page is listed; the other windows and DevTools open a moment later, and the settings
    // window only gets its title once its router has run, so wait for them to be settled before the host sees the list.
    if (settingsWindow || devtools) {
      await waitUntil(() => discovery(app.rendererPort), (targets) =>
        (!settingsWindow || ["Task Board", "Settings - Task Board"].every((title) => targets?.some((target) => target.title === title)))
        && (!devtools || targets?.some((target) => target.url.startsWith("devtools://"))),
      "app windows", 30_000);
    }
    // A single window is handed over loaded: the first load goes through the dev server's on-demand compile, and a host
    // that attaches in the middle of it reads an empty page. With several windows the host has to choose, so it reads
    // what is there.
    const single = !windowless && !settingsWindow && !devtools;
    const steps = [...(single ? loaded : []), ...(before ?? [])];
    if (steps.length) await runBefore(endpoints, steps);
  } catch (error) {
    await app.stop();
    throw error;
  }
  return { endpoints, app, stop: () => app.stop() };
}
