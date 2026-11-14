import { DiagnosticException } from "../errors.js";
import type { DiagnosticEvent, LogsInput, ProcessScope } from "../types.js";

function byteSize(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value) ?? "", "utf8");
  } catch {
    return Number.MAX_SAFE_INTEGER;
  }
}

export class EventBuffer {
  private readonly events: DiagnosticEvent[] = [];
  private bytes = 0;

  constructor(
    private readonly maxEvents: number,
    private readonly maxBytes: number,
  ) {}

  add(event: DiagnosticEvent): void {
    const normalized: DiagnosticEvent = {
      ...event,
      message: event.message.slice(0, 8_192),
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
