import assert from "node:assert/strict";
import test from "node:test";
import { EventBuffer } from "../src/events/event-buffer.js";
import { DiagnosticException } from "../src/errors.js";
import type { DiagnosticEvent } from "../src/types.js";

const event = (message: string, process: "main" | "renderer" = "main"): DiagnosticEvent => ({
  process,
  observedAt: new Date().toISOString(),
  kind: "console",
  level: "log",
  message,
});

test("keeps event count bounded", () => {
  const buffer = new EventBuffer(2, 10_000);
  buffer.add(event("one"));
  buffer.add(event("two"));
  buffer.add(event("three"));
  assert.deepEqual(buffer.list({ limit: 10 }).map((item) => item.message), ["two", "three"]);
});

test("keeps event bytes bounded and supports scoped clearing", () => {
  const buffer = new EventBuffer(10, 250);
  buffer.add(event("a".repeat(100)));
  buffer.add(event("b".repeat(100)));
  assert.ok(buffer.list({ limit: 10 }).length <= 2);
  buffer.clear();
  assert.equal(buffer.size, 0);
});

test("rejects an invalid since timestamp", () => {
  const buffer = new EventBuffer(10, 10_000);
  assert.throws(
    () => buffer.list({ since: "not-a-date" }),
    (error: unknown) =>
      error instanceof DiagnosticException &&
      error.diagnostic.code === "INVALID_ARGUMENT",
  );
});
