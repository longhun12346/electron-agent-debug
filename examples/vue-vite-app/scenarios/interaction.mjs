import assert from "node:assert/strict";
import { taskCount, withSession } from "../support.mjs";

// Click and type by snapshot ref, against Chromium itself. What matters here only shows in a real page: whether the
// events are trusted, whether quads and hit tests agree on a 2x screen, and how a Vue-controlled input and CJK text behave.
export const scenarios = {};

function refOf(text, line) {
  const match = text.split("\n").find((candidate) => candidate.includes(line))?.match(/\[ref=([a-z]{3}\d+)\]/u);
  assert.ok(match, `no ref for ${line} in:\n${text}`);
  return match[1];
}

scenarios.interaction = () => withSession({ built: true, electronArgs: ["--force-device-scale-factor=2"] }, async (s) => {
  await s.attach();
  await s.renderer(taskCount(2));
  const record = `window.__events = [];
    for (const type of ['click', 'input']) document.addEventListener(type, (event) => window.__events.push({
      type, trusted: event.isTrusted, detail: event.detail, name: event.target.textContent?.trim() || event.target.getAttribute('aria-label') }), true);
    true`;
  await s.evaluate("renderer", record);
  const clicks = async (name) => (await s.evaluate("renderer", "window.__events")).filter((event) => event.type === "click" && event.name === name);
  const syncClicks = () => clicks("Sync");

  let snapshot = await s.call("electron_dom_snapshot", {});
  assert.ok(snapshot.refCount >= 7, snapshot.text);
  assert.doesNotMatch(snapshot.text.split("\n").find((line) => line.includes("heading")) ?? "", /\[ref=/u);
  let sync = refOf(snapshot.text, 'button "Sync"');

  // A trusted click, and afterSeq leads to what the page logged after it.
  const clicked = await s.call("electron_click", { ref: sync });
  assert.equal(clicked.role, "button");
  assert.deepEqual((await syncClicks()).map((event) => event.trusted), [true]);
  await s.renderer("!document.body.innerText.includes('Last sync: never')");
  await s.call("electron_click", { ref: sync, doubleClick: true });
  assert.deepEqual((await syncClicks()).map((event) => event.detail), [1, 1, 2]);

  // Off-screen: scrolled into view first, still trusted. The Activity page is 1500 rows long.
  await s.call("electron_click", { role: "link", name: "Activity" });
  await s.renderer("document.querySelectorAll('li').length > 1000");
  assert.equal(await s.evaluate("renderer", "window.scrollY"), 0);
  await s.call("electron_click", { role: "button", name: "Clear history" });
  await s.renderer("document.body.innerText.includes('0 entries')");
  assert.equal((await clicks("Clear history")).at(-1).trusted, true);
  await s.call("electron_click", { role: "link", name: "Tasks" });
  await s.renderer(taskCount(2));
  snapshot = await s.call("electron_dom_snapshot", {});
  sync = refOf(snapshot.text, 'button "Sync"'); // the page was re-rendered, so the button is a new element

  // Covered and disabled elements are refused, and nothing is clicked.
  const before = (await syncClicks()).length;
  await s.evaluate("renderer", `const overlay = document.createElement('div');
    overlay.id = 'overlay'; overlay.style.cssText = 'position:fixed;inset:0;z-index:9999';
    document.body.append(overlay); true`);
  const covered = await s.failure("electron_click", { ref: refOf(snapshot.text, 'button "Sync"') });
  assert.equal(covered.code, "ELEMENT_COVERED", JSON.stringify(covered));
  assert.equal(covered.details.coveredBy.id, "overlay");
  await s.evaluate("renderer", "document.getElementById('overlay').remove(); true");
  await s.evaluate("renderer", "[...document.querySelectorAll('button')].find((button) => button.textContent === 'Sync').disabled = true; true");
  assert.equal((await s.failure("electron_click", { role: "button", name: "Sync" })).code, "ELEMENT_DISABLED");
  await s.evaluate("renderer", "[...document.querySelectorAll('button')].find((button) => button.textContent === 'Sync').disabled = false; true");
  assert.equal((await syncClicks()).length, before);

  // Typing: CJK text, replacement by default, appending, a Vue-controlled input, submit, and a non-editable target.
  const field = refOf(snapshot.text, 'textbox "New task"');
  assert.equal((await s.call("electron_type", { ref: field, text: "你好 abc" })).value, "你好 abc");
  assert.equal((await s.call("electron_type", { ref: field, text: "first" })).value, "first");
  assert.equal((await s.call("electron_type", { ref: field, text: "-more", clear: false })).value, "first-more");
  assert.ok((await s.evaluate("renderer", "window.__events")).filter((event) => event.type === "input").every((event) => event.trusted));
  await s.call("electron_type", { ref: field, text: "你好 任务", submit: true });
  await s.renderer(`${taskCount(3)} && [...document.querySelectorAll('li.task')].some((item) => item.textContent.includes('你好 任务'))`);
  assert.equal(await s.evaluate("renderer", "document.querySelector('input[aria-label=\"New task\"]').value"), "", "Vue cleared the controlled input");
  await s.call("electron_type", { role: "searchbox", name: "Search tasks", text: "no-such-task", submit: true });
  await s.renderer(taskCount(0));
  assert.equal((await s.failure("electron_type", { ref: sync, text: "x" })).code, "ELEMENT_NOT_EDITABLE");
  await s.call("electron_type", { role: "searchbox", name: "Search tasks", text: "" });
  await s.renderer(taskCount(3));

  // Refs: unknown, stable across snapshots of the same page, stale after a reload.
  assert.equal((await s.failure("electron_click", { ref: `${sync.slice(0, 3)}99999` })).code, "REF_NOT_FOUND");
  const foreign = await s.failure("electron_click", { ref: sync.startsWith("zzz") ? "yyy1" : "zzz1" });
  assert.equal(foreign.code, "REF_NOT_FOUND");
  assert.match(foreign.hint, /role/u, "a ref from another run points to role and name");
  snapshot = await s.call("electron_dom_snapshot", {});
  assert.equal(refOf(snapshot.text, 'button "Sync"'), sync, "the same element keeps its ref");
  await s.evaluate("renderer", "location.reload(); true");
  await s.renderer(taskCount(3));
  assert.equal((await s.failure("electron_click", { ref: sync })).code, "REF_STALE");
  snapshot = await s.call("electron_dom_snapshot", {});
  await s.evaluate("renderer", record);
  await s.call("electron_click", { ref: refOf(snapshot.text, 'button "Sync"') });
  assert.equal((await syncClicks()).length, 1, "a fresh ref works after the reload");

  // Role and name: no ref needed, so a batch run can find, press and wait in one go; ambiguity is refused.
  const byName = await s.call("electron_click", { role: "button", name: "Sync" });
  assert.equal(byName.ref, refOf(snapshot.text, 'button "Sync"'), "the same element gets the same ref");
  assert.equal((await syncClicks()).at(-1).trusted, true);
  await s.evaluate("renderer", "const twin = document.createElement('button'); twin.textContent = 'Sync'; document.body.append(twin); true");
  assert.equal((await s.failure("electron_click", { role: "button", name: "Sync" })).code, "ELEMENT_AMBIGUOUS");
  assert.equal((await s.failure("electron_click", { role: "button", name: "Nope" })).code, "ELEMENT_NOT_FOUND");
  const interactive = await s.call("electron_dom_snapshot", { interactive: true });
  assert.ok(interactive.text.split("\n").every((line) => /\[ref=|heading/u.test(line)), interactive.text);
});
