import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { taskCount, withSession } from "../support.mjs";

// The kinds of bug real apps have, each with the evidence the tools have to surface.
export const scenarios = {};

scenarios["ipc-channel"] = () => withSession({ fault: "ipc-channel" }, async (s) => {
  await s.attach({ instrument: ["ipc"] });
  await s.renderer(taskCount(2));
  await s.call("electron_type", { role: "textbox", name: "New task", text: "Ship the demo" });
  const clicked = await s.call("electron_click", { role: "button", name: "Add" });
  const failed = await s.call("electron_wait_for", {
    log: { contains: "No handler registered for 'tasks:add'", process: "renderer", afterSeq: clicked.afterSeq }, timeoutMs: 10_000,
  });
  assert.equal(failed.event.level, "error");
  assert.equal(await s.evaluate("renderer", "document.querySelectorAll('li.task').length"), 2, "the list did not change");
});

scenarios["silent-send"] = () => withSession({ fault: "silent-send" }, async (s) => {
  await s.attach({ instrument: ["ipc"] });
  await s.renderer(taskCount(2));
  const clicked = await s.call("electron_click", { role: "button", name: "Sync" });
  await s.call("electron_wait_for", { log: { contains: "sync:start", process: "main", afterSeq: clicked.afterSeq }, timeoutMs: 10_000 });
  const events = await s.logs({ afterSeq: clicked.afterSeq });
  assert.ok(events.some((event) => event.kind === "ipc" && event.data?.channel === "sync:start" && event.data?.listeners === 0),
    `the message without a listener is traced: ${JSON.stringify(events)}`);
  await delay(500);
  assert.match(await s.evaluate("renderer", "document.body.innerText"), /Last sync: never/u);
});

scenarios["missing-field"] = () => withSession({ fault: "missing-field" }, async (s) => {
  await s.attach();
  await s.renderer(taskCount(2));
  await s.call("electron_type", { role: "textbox", name: "New task", text: "Ship the demo" });
  const clicked = await s.call("electron_click", { role: "button", name: "Add" });
  const failed = await s.call("electron_wait_for", {
    log: { contains: "reading 'name'", process: "renderer", afterSeq: clicked.afterSeq }, timeoutMs: 10_000,
  });
  assert.match(failed.event.message, /TypeError/u);
  const warned = await s.logs({ process: "renderer", afterSeq: clicked.afterSeq });
  assert.ok(warned.some((event) => event.message?.includes("[Vue warn]")), "Vue names the component that failed to render");
});

scenarios["damaged-data"] = () => withSession({ store: "{ not json" }, async (s) => {
  await s.attach();
  await s.renderer("!!document.querySelector('[role=alert]')");
  assert.match(await s.evaluate("renderer", "document.querySelector('[role=alert]').textContent"), /Could not load tasks/u);
  const events = await s.logs({});
  assert.ok(events.some((event) => event.process === "main" && /Error occurred in handler for 'tasks:list'.*SyntaxError/su.test(event.message)),
    "the main process says which handler failed and why");
  assert.ok(events.some((event) => event.process === "renderer" && event.message?.includes("load tasks failed")));
});

// The window never appears: the main process is up, there is no page, and its log says why.
scenarios["bad-window-file"] = () => withSession({ files: { "window.json": "{ nope" }, windowless: true }, async (s) => {
  const attached = await s.attach();
  assert.equal(attached.main.online, true);
  assert.equal(attached.renderer.online, false, "no window, no renderer page");
  assert.equal(attached.selectedTarget, undefined);
  const events = await s.logs({ process: "main" });
  assert.ok(events.some((event) => event.message?.includes("Could not create the main window")), JSON.stringify(events));
});

// The window opens, but the preload script was not found, so the page has no bridge to the main process.
scenarios["preload-path"] = () => withSession({ fault: "preload-path" }, async (s) => {
  await s.attach();
  await s.call("electron_wait_for", { log: { contains: "reading 'listTasks'", process: "renderer" }, timeoutMs: 20_000 });
  assert.equal(await s.evaluate("renderer", "typeof window.api"), "undefined");
  const events = await s.logs({ process: "renderer" });
  const missing = events.find((event) => /Unable to load preload script/u.test(event.message ?? ""));
  assert.ok(missing, JSON.stringify(events.slice(-8)));
  assert.match(missing.message, /index\.mjs/u, "the log names the path that was tried");
});
