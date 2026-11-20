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

export const sessionConnectedMessage = "Session connected";

export class EventBuffer {
  private readonly events: DiagnosticEvent[] = [];
  // Serialized size of each retained event, kept beside it so eviction does not serialize it again.
  private readonly sizes: number[] = [];
  private bytes = 0;
  private lastDroppedSeq = 0;
  private connectedSeq = 0;
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
    if (normalized.kind === "connection" && normalized.message === sessionConnectedMessage) {
      this.connectedSeq = normalized.seq ?? this.connectedSeq;
    }
    const size = byteSize(normalized);
    if (size > this.maxBytes) {
      this.lastDroppedSeq = Math.max(this.lastDroppedSeq, normalized.seq ?? 0);
      return;
    }

    this.events.push(normalized);
    this.sizes.push(size);
    this.bytes += size;
    while (this.events.length > this.maxEvents || this.bytes > this.maxBytes) {
      const removed = this.events.shift();
      const removedSize = this.sizes.shift();
      if (removed) {
        this.bytes -= removedSize ?? byteSize(removed);
        this.lastDroppedSeq = Math.max(this.lastDroppedSeq, removed.seq ?? 0);
      }
    }
  }

  // Highest seq this buffer evicted or refused since it was last cleared. Events at or below it may be missing;
  // events the caller cleared on purpose do not count.
  get droppedThroughSeq(): number {
    return this.lastDroppedSeq;
  }

  // Seq of the newest "Session connected" event this buffer has seen, or 0. Attaching replays the application's earlier
  // console output before this event is written, so everything newer was observed by the current connection. It is
  // remembered after the event itself is evicted or cleared, so the boundary stays exact.
  get lastConnectedSeq(): number {
    return this.connectedSeq;
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
    this.sizes.length = 0;
    this.bytes = 0;
    this.lastDroppedSeq = 0;
  }

  get size(): number {
    return this.events.length;
  }
}
