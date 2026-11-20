import assert from "node:assert/strict";
import test from "node:test";
import { selectTarget } from "../src/targets/selector.js";
import { DiagnosticException } from "../src/errors.js";
import type { TargetInfo } from "../src/types.js";

const page = (id: string, title: string): TargetInfo => ({
  id,
  type: "page",
  title,
  url: `http://127.0.0.1/${id}`,
  webSocketDebuggerUrl: `ws://127.0.0.1/devtools/page/${id}`,
});

function codeOf(callback: () => unknown): string {
  try {
    callback();
  } catch (error) {
    assert.ok(error instanceof DiagnosticException);
    return error.diagnostic.code;
  }
  throw new Error("expected callback to throw");
}

test("selects the only page automatically", () => {
  assert.equal(selectTarget([page("one", "One")], {})?.id, "one");
});

test("requires an explicit selector for multiple pages", () => {
  assert.equal(codeOf(() => selectTarget([page("one", "One"), page("two", "Two")], {})), "TARGET_SELECTION_REQUIRED");
});

test("returns target not found for an unmatched explicit selector", () => {
  assert.equal(codeOf(() => selectTarget([page("one", "One")], { targetId: "missing" })), "TARGET_NOT_FOUND");
});

test("ignores non-page targets for automatic selection", () => {
  const worker: TargetInfo = { id: "worker", type: "worker", title: "", url: "" };
  assert.equal(codeOf(() => selectTarget([worker], {})), "TARGET_NOT_FOUND");
});

const devtools = (id: string): TargetInfo => ({
  ...page(id, "DevTools"),
  url: "devtools://devtools/bundled/devtools_app.html?remoteBase=https://example.invalid",
});

test("a DevTools window next to one real window does not make the selection ambiguous", () => {
  assert.equal(selectTarget([devtools("tools"), page("app", "App")], {})?.id, "app");
  assert.equal(selectTarget([page("app", "App"), devtools("tools")], {})?.id, "app");
});

test("real windows stay ambiguous when DevTools is also open, and the count excludes DevTools", () => {
  try {
    selectTarget([devtools("tools"), page("one", "One"), page("two", "Two")], {});
    assert.fail("expected a selection error");
  } catch (error) {
    assert.ok(error instanceof DiagnosticException);
    assert.equal(error.diagnostic.code, "TARGET_SELECTION_REQUIRED");
    assert.equal(error.diagnostic.details?.count, 2);
  }
});

test("DevTools can still be chosen explicitly and is selected when it is the only page", () => {
  assert.equal(selectTarget([devtools("tools"), page("app", "App")], { targetId: "tools" })?.id, "tools");
  assert.equal(selectTarget([devtools("tools")], {})?.id, "tools");
});

test("ignores page targets without a debugger WebSocket", () => {
  const unavailable: TargetInfo = {
    id: "unavailable",
    type: "page",
    title: "Unavailable",
    url: "http://127.0.0.1/unavailable",
  };
  assert.equal(selectTarget([unavailable, page("available", "Available")], {})?.id, "available");
  assert.equal(codeOf(() => selectTarget([unavailable], {})), "TARGET_NOT_FOUND");
});

test("explains when an explicitly selected page is not attachable", () => {
  const unavailable: TargetInfo = {
    id: "unavailable",
    type: "page",
    title: "Unavailable",
    url: "http://127.0.0.1/unavailable",
  };
  assert.equal(
    codeOf(() => selectTarget([unavailable], { targetId: "unavailable" })),
    "TARGET_NOT_FOUND",
  );
});

for (const field of ["url", "title"] as const) {
  test(`requires targetId when multiple connectable windows share ${field}`, () => {
    const first = page("first", "Shared");
    const second = { ...page("second", "Shared"), url: first.url };
    assert.equal(
      codeOf(() => selectTarget([first, second], { [field]: first[field] })),
      "TARGET_SELECTION_REQUIRED",
    );
    assert.equal(
      selectTarget([first, second], { targetId: "second", [field]: first[field] })?.id,
      "second",
    );
  });

  test(`ignores unconnectable ${field} matches when there is one connectable match`, () => {
    const available = page("available", "Shared");
    const unavailable = { ...available, id: "unavailable", webSocketDebuggerUrl: undefined };
    assert.equal(
      selectTarget([unavailable, available], { [field]: available[field] })?.id,
      "available",
    );
  });

  test(`returns not found for a missing explicit ${field}`, () => {
    assert.equal(
      codeOf(() => selectTarget([page("one", "One")], { [field]: "missing" })),
      "TARGET_NOT_FOUND",
    );
  });
}
