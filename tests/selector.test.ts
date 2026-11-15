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
  assert.equal(selectTarget([page("one", "One")], {}).id, "one");
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

test("ignores page targets without a debugger WebSocket", () => {
  const unavailable: TargetInfo = {
    id: "unavailable",
    type: "page",
    title: "Unavailable",
    url: "http://127.0.0.1/unavailable",
  };
  assert.equal(selectTarget([unavailable, page("available", "Available")], {}).id, "available");
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
