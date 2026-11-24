import { DiagnosticException } from "../errors.js";
import type { DiagnosticEvent, LogsInput, ProcessScope } from "../types.js";

function byteSize(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value) ?? "", "utf8");
  } catch {
    return Number.MAX_SAFE_INTEGER;
  }
}

// Event data is kept as plain JSON. Unserializable data is returned untouched so the size check below rejects the event.
function plainData(data: unknown): unknown {
  try {
    const serialized = JSON.stringify(data);
    return serialized === undefined ? undefined : JSON.parse(serialized) as unknown;
  } catch {
    return data;
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

const maxMessageChars = 8_192;

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
      message: event.message.slice(0, maxMessageChars),
      ...(event.data === undefined ? {} : { data: plainData(event.data) }),
    };
    // A message cut to the limit says so, with its original length, instead of looking complete.
    if (event.message.length > maxMessageChars) {
      const data = normalized.data;
      if (data === undefined || (typeof data === "object" && data !== null && !Array.isArray(data))) {
        normalized.data = { ...(data as Record<string, unknown> | undefined), messageTruncatedFrom: event.message.length };
      }
    }
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

  /** Removes the events with these seq numbers and keeps the rest, without touching the eviction bookkeeping. */
  remove(seqs: ReadonlySet<number>): void {
    const keep: DiagnosticEvent[] = [];
    const keepSizes: number[] = [];
    this.events.forEach((event, index) => {
      if (event.seq !== undefined && seqs.has(event.seq)) return;
      keep.push(event);
      keepSizes.push(this.sizes[index] ?? byteSize(event));
    });
    this.events.length = 0;
    this.events.push(...keep);
    this.sizes.length = 0;
    this.sizes.push(...keepSizes);
    this.bytes = keepSizes.reduce((sum, size) => sum + size, 0);
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
