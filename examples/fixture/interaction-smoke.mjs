import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { McpClient, structuredData, freePort, discovery, waitUntil, stopChild } from "./test-support.mjs";

// Real Electron: click and type by snapshot ref. What matters here only shows in Chromium itself: whether the events
// are trusted, whether quads and hit tests agree on a 2x screen, and how a controlled input and CJK text behave.
const electron = createRequire(import.meta.url)("electron");
const fixtureRoot = path.dirname(fileURLToPath(import.meta.url));
const [mainPort, rendererPort] = [await freePort(), await freePort()];
const args = [`--inspect=${mainPort}`, `--remote-debugging-port=${rendererPort}`, "--force-device-scale-factor=2", fixtureRoot];
if (process.env.FIXTURE_ELECTRON_NO_SANDBOX === "true") args.unshift("--no-sandbox");
const env = { ...process.env, FIXTURE_RENDERER_PORT: rendererPort };
delete env.FIXTURE_FAULT;
const fixture = spawn(electron, args, { stdio: ["ignore", "inherit", "inherit", "ipc"], env });
const client = new McpClient({});

let requestId = 1;
async function raw(tool, toolArguments = {}) {
  const response = await client.request(requestId++, "tools/call", { name: tool, arguments: toolArguments }, 30_000);
  assert.ok(response.result?.structuredContent, `${tool}: ${JSON.stringify(response)}`);
  return response;
}
const call = async (tool, toolArguments) => structuredData(await raw(tool, toolArguments), tool);
async function failure(tool, toolArguments) {
  const response = await raw(tool, toolArguments);
  assert.equal(response.result.isError, true, `${tool} should fail: ${JSON.stringify(response)}`);
  return response.result.structuredContent.error;
}
const evaluate = async (scope, expression) => (await call("electron_evaluate", { scope, expression })).value;
const events = () => evaluate("renderer", "window.interactionEvents");

function refOf(text, line) {
  const match = text.split("\n").find((candidate) => candidate.includes(line))?.match(/\[ref=([a-z]{3}\d+)\]/u);
  assert.ok(match, `no ref for ${line} in:\n${text}`);
  return match[1];
}

try {
  await Promise.all([
    waitUntil(() => discovery(mainPort), Array.isArray, "main discovery"),
    waitUntil(() => discovery(rendererPort),
      (targets) => targets?.some((target) => target.type === "page"), "renderer discovery"),
  ]);
  await client.request(requestId++, "initialize", {
    protocolVersion: "2025-03-26", capabilities: {},
    clientInfo: { name: "fixture-interaction-smoke", version: "1.0.0" },
  });
  client.notify("notifications/initialized", {});
  const attached = await call("electron_attach", {
    mainUrl: `http://127.0.0.1:${mainPort}`, rendererUrl: `http://127.0.0.1:${rendererPort}`,
  });
  assert.ok(attached.main.online && attached.renderer.online, JSON.stringify(attached));
  await evaluate("main", `(async () => {
    const { app, BrowserWindow } = process.mainModule.require('electron');
    const path = process.getBuiltinModule('path');
    await BrowserWindow.getAllWindows()[0].loadFile(path.join(app.getAppPath(), 'interaction.html'));
    return true;
  })()`);
  await call("electron_wait_for", {
    expression: { scope: "renderer", expression: "document.title === 'Interaction Fixture' && !!window.interactionEvents" },
    timeoutMs: 10_000,
  });

  let snapshot = await call("electron_dom_snapshot", {});
  assert.ok(snapshot.refCount >= 7, snapshot.text);
  assert.doesNotMatch(snapshot.text.split("\n").find((line) => line.includes("heading")) ?? "", /\[ref=/u);
  const save = refOf(snapshot.text, 'button "Save"');

  // A trusted click, and afterSeq leads to the page's own log line about it.
  const clicked = await call("electron_click", { ref: save });
  assert.equal(clicked.role, "button");
  const logged = await call("electron_wait_for", {
    log: { contains: '"id":"save"', process: "renderer", afterSeq: clicked.afterSeq }, timeoutMs: 5_000,
  });
  assert.match(logged.event.message, /"trusted":true/u);
  await call("electron_click", { ref: save, doubleClick: true });
  assert.deepEqual((await events()).filter((event) => event.id === "save").map((event) => event.detail), [1, 1, 2]);

  // Off-screen: scrolled into view first, still trusted.
  await call("electron_click", { ref: refOf(snapshot.text, 'button "Far away"') });
  assert.equal((await events()).at(-1).id, "far");

  // Covered and disabled elements are refused, and nothing is clicked.
  await evaluate("renderer", "window.scrollTo(0, 0); window.showOverlay(true); true");
  const before = (await events()).length;
  const covered = await failure("electron_click", { ref: refOf(snapshot.text, 'button "Covered"') });
  assert.equal(covered.code, "ELEMENT_COVERED", JSON.stringify(covered));
  assert.equal(covered.details.coveredBy.id, "overlay");
  await evaluate("renderer", "window.showOverlay(false); true");
  assert.equal((await failure("electron_click", { ref: refOf(snapshot.text, 'button "Locked"') })).code, "ELEMENT_DISABLED");
  assert.equal((await events()).length, before);

  // Typing: CJK text, replacement by default, appending, a controlled input, submit, and a non-editable target.
  const name = refOf(snapshot.text, 'textbox "Name"');
  const typed = await call("electron_type", { ref: name, text: "你好 abc" });
  assert.equal(typed.value, "你好 abc");
  assert.equal((await call("electron_type", { ref: name, text: "first" })).value, "first");
  assert.equal((await call("electron_type", { ref: name, text: "-more", clear: false })).value, "first-more");
  assert.ok((await events()).filter((event) => event.id === "name").every((event) => event.trusted));
  const controlled = refOf(snapshot.text, 'textbox "Controlled"');
  await call("electron_type", { ref: controlled, text: "react-ok" });
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(await evaluate("renderer", "document.getElementById('controlled').value"), "react-ok",
    "a controlled input must keep what was typed");
  await call("electron_type", { ref: refOf(snapshot.text, 'searchbox "Search"'), text: "query", submit: true });
  assert.deepEqual((await events()).at(-1), { type: "submit", value: "query" });
  assert.equal((await failure("electron_type", { ref: save, text: "x" })).code, "ELEMENT_NOT_EDITABLE");

  // Refs: unknown, stable across snapshots of the same page, stale after a reload.
  assert.equal((await failure("electron_click", { ref: `${save.slice(0, 3)}99999` })).code, "REF_NOT_FOUND");
  const foreign = await failure("electron_click", { ref: save.startsWith("zzz") ? "yyy1" : "zzz1" });
  assert.equal(foreign.code, "REF_NOT_FOUND");
  assert.match(foreign.hint, /role/u, "a ref from another run points to role and name");
  snapshot = await call("electron_dom_snapshot", {});
  assert.equal(refOf(snapshot.text, 'button "Save"'), save, "the same element keeps its ref");
  await evaluate("renderer", "location.reload(); true");
  await call("electron_wait_for", {
    expression: { scope: "renderer", expression: "document.readyState === 'complete' && !!window.interactionEvents" },
    timeoutMs: 10_000,
  });
  assert.equal((await failure("electron_click", { ref: save })).code, "REF_STALE");
  snapshot = await call("electron_dom_snapshot", {});
  await call("electron_click", { ref: refOf(snapshot.text, 'button "Save"') });
  assert.equal((await events()).length, 1, "a fresh ref works after the reload");

  // Role and name: no ref needed, so a batch run can find, press and wait in one go; ambiguity is refused.
  const byName = await call("electron_click", { role: "button", name: "Save" });
  assert.equal(byName.ref, refOf(snapshot.text, 'button "Save"'), "the same element gets the same ref");
  assert.equal((await events()).at(-1).trusted, true);
  await evaluate("renderer", "const twin = document.createElement('button'); twin.textContent = 'Save'; document.body.append(twin); true");
  assert.equal((await failure("electron_click", { role: "button", name: "Save" })).code, "ELEMENT_AMBIGUOUS");
  assert.equal((await failure("electron_click", { role: "button", name: "Nope" })).code, "ELEMENT_NOT_FOUND");
  const interactive = await call("electron_dom_snapshot", { interactive: true });
  assert.ok(interactive.text.split("\n").every((line) => /\[ref=|heading/u.test(line)), interactive.text);

  console.log(JSON.stringify({ platform: process.platform, interaction: "PASS", refs: snapshot.refCount }));
} finally {
  await client.close();
  await stopChild(fixture, () => fixture.send({ command: "quit" }));
}
