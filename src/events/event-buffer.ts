import { DiagnosticException } from "../errors.js";
import { redact } from "../redact.js";
import type { DiagnosticEvent, LogsInput, ProcessScope } from "../types.js";

function byteSize(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value) ?? "", "utf8");
  } catch {
    return Number.MAX_SAFE_INTEGER;
  }
}

// Unserializable data is returned untouched so the size check below rejects the event.
function redactData(data: unknown): unknown {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(data);
  } catch {
    return data;
  }
  if (serialized === undefined) {
    return undefined;
  }
  const safe = redact(serialized);
  try {
    return JSON.parse(safe) as unknown;
  } catch {
    return safe;
  }
}

export class EventSequence {
  private value = 0;

  next(): number {
    this.value += 1;
    return this.value;
  }

  get last(): number {
    return this.value;
  }
}

export class EventBuffer {
  private readonly events: DiagnosticEvent[] = [];
  private bytes = 0;

  constructor(
    private readonly maxEvents: number,
    private readonly maxBytes: number,
    private readonly sequence = new EventSequence(),
  ) {}

  add(event: DiagnosticEvent): void {
    const normalized: DiagnosticEvent = {
      ...event,
      seq: this.sequence.next(),
      message: redact(event.message.slice(0, 8_192)),
      ...(event.data === undefined ? {} : { data: redactData(event.data) }),
    };
    const size = byteSize(normalized);
    if (size > this.maxBytes) {
      return;
    }

    this.events.push(normalized);
    this.bytes += size;
    while (this.events.length > this.maxEvents || this.bytes > this.maxBytes) {
      const removed = this.events.shift();
      if (removed) {
        this.bytes -= byteSize(removed);
      }
    }
  }

  list(input: LogsInput = {}): DiagnosticEvent[] {
    const process = input.process ?? "all";
    const since = input.since ? Date.parse(input.since) : undefined;
    if (input.since && Number.isNaN(since)) {
      throw new DiagnosticException("INVALID_ARGUMENT", "since 必须是有效的日期时间字符串");
    }
    const limit = Math.min(Math.max(input.limit ?? 100, 1), this.maxEvents);

    return this.events
      .filter((event) => process === "all" || event.process === (process as ProcessScope))
      .filter((event) => !input.level || event.level === input.level)
      .filter((event) => since === undefined || Date.parse(event.observedAt) >= since)
      .filter((event) => input.afterSeq === undefined || (event.seq ?? 0) > input.afterSeq)
      .slice(-limit);
  }

  clear(): void {
    this.events.length = 0;
    this.bytes = 0;
  }

  get size(): number {
    return this.events.length;
  }
}
