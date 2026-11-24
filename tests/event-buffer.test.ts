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

test("evicts oldest events by serialized UTF-8 bytes before the count limit", () => {
  const samples = ["甲", "乙", "丙"].map((message) => ({
    ...event(message.repeat(40)),
    observedAt: "2026-01-01T00:00:00.000Z",
  }));
  const probe = new EventBuffer(100, 10_000);
  probe.add(samples[0]!);
  const size = Buffer.byteLength(JSON.stringify(probe.list()[0]), "utf8");
  const buffer = new EventBuffer(100, size * 2);
  for (const sample of samples) buffer.add(sample);
  assert.deepEqual(buffer.list().map((item) => item.message), samples.slice(1).map((item) => item.message));
  assert.equal(buffer.size, 2);
  const bytes = buffer.list().reduce((total, item) =>
    total + Buffer.byteLength(JSON.stringify(item), "utf8"), 0);
  assert.equal(bytes, size * 2);
  buffer.clear();
  assert.equal(buffer.size, 0);
  buffer.add(samples[0]!);
  buffer.add(samples[1]!);
  assert.equal(buffer.size, 2, "clear must reset the byte accounting");
});

test("drops one oversized data payload without discarding retained evidence", () => {
  const buffer = new EventBuffer(10, 1_000);
  buffer.add(event("before"));
  buffer.add({ ...event("oversized"), data: { detail: "x".repeat(2_000) } });
  buffer.add(event("after"));
  assert.deepEqual(buffer.list().map((item) => item.message), ["before", "after"]);
});

test("truncates long console messages and rejects unserializable data", () => {
  const buffer = new EventBuffer(10, 100_000);
  buffer.add(event("x".repeat(20_000)));
  const circular: Record<string, unknown> = {};
  circular.self = circular;
  buffer.add({ ...event("circular"), data: circular });
  assert.equal(buffer.size, 1);
  assert.equal(buffer.list()[0]?.message.length, 8_192);
});

test("stores the message and the data as the application produced them, without masking anything", () => {
  const buffer = new EventBuffer(10, 100_000);
  const data = { text: "token=abcdef123456 ok", nested: [{ authorization: "Bearer abc.def-ghi_jkl123" }], line: 3 };
  buffer.add({ ...event("password=hunter2hunter2"), data });
  const stored = buffer.list()[0]!;
  assert.equal(stored.message, "password=hunter2hunter2");
  assert.deepEqual(stored.data, data);
});

test("tracks the highest evicted or refused seq and resets it on clear", () => {
  const buffer = new EventBuffer(2, 1_000);
  buffer.add(event("one"));
  buffer.add(event("two"));
  assert.equal(buffer.droppedThroughSeq, 0);
  buffer.add(event("three"));
  assert.equal(buffer.droppedThroughSeq, 1);
  buffer.add({ ...event("oversized"), data: { detail: "x".repeat(2_000) } });
  assert.equal(buffer.droppedThroughSeq, 4, "an event refused for size leaves a gap at its own seq");
  buffer.clear();
  assert.equal(buffer.droppedThroughSeq, 0);
});

test("lastConnectedSeq remembers the newest connection marker after it is evicted or cleared", () => {
  const buffer = new EventBuffer(3, 100_000);
  const connected = { ...event("Session connected"), kind: "connection" as const, level: "info" };
  assert.equal(buffer.lastConnectedSeq, 0);
  buffer.add(event("replayed"));
  buffer.add(connected);
  assert.equal(buffer.lastConnectedSeq, 2);
  buffer.add(event("fresh"));
  buffer.add(connected);
  assert.equal(buffer.lastConnectedSeq, 4, "a reconnect moves the boundary");
  buffer.add(event("one"));
  buffer.add(event("two"));
  buffer.add(event("three"));
  assert.equal(buffer.list({ limit: 10 }).some((item) => item.message === "Session connected"), false);
  assert.equal(buffer.lastConnectedSeq, 4, "the boundary outlives the evicted event");
  buffer.clear();
  buffer.add({ ...event("disconnected"), kind: "connection" as const, level: "error" });
  assert.equal(buffer.lastConnectedSeq, 4, "only the connected marker moves it, not other connection events");
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

test("an EventBuffer removes only the events it is told to and keeps its size accounting", () => {
  const buffer = new EventBuffer(100, 100_000);
  for (const message of ["a", "b", "c"]) {
    buffer.add({ process: "main", message, observedAt: "2026-01-01T00:00:00.000Z", level: "log", kind: "console" });
  }
  const [first, second, third] = buffer.list();
  buffer.remove(new Set([second!.seq as number]));
  assert.deepEqual(buffer.list().map((event) => event.message), ["a", "c"]);
  assert.equal(buffer.size, 2);
  assert.equal(buffer.list()[0]?.seq, first!.seq);
  assert.equal(buffer.list()[1]?.seq, third!.seq);
});
