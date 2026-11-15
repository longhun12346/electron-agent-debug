import { EventBuffer } from "../events/event-buffer.js";
import { DiagnosticException, toDiagnosticError } from "../errors.js";
import { JsonRpcConnection, type JsonRpcEvent } from "../protocol/json-rpc-connection.js";
import type {
  DiagnosticEvent,
  EndpointConfig,
  ProcessScope,
  PublicSessionStatus,
  SessionSnapshot,
  TargetInfo,
} from "../types.js";

export interface SessionOptions {
  process: ProcessScope;
  requestTimeoutMs: number;
  maxProtocolMessageBytes: number;
  maxLogEvents: number;
  maxLogBytes: number;
  onDisconnected?: () => void;
}

function stringifyValue(value: unknown): string {
  try {
    const json = JSON.stringify(value);
    return json === undefined ? String(value) : json;
  } catch {
    return "[unserializable]";
  }
}

function formatConsoleArgument(value: unknown): string {
  if (typeof value !== "object" || value === null) {
    return typeof value === "string" ? value : stringifyValue(value);
  }

  const record = value as Record<string, unknown>;
  if ("value" in record) {
    return typeof record.value === "string" ? record.value : stringifyValue(record.value);
  }
  if (typeof record.unserializableValue === "string") {
    return record.unserializableValue;
  }
  if (typeof record.description === "string") {
    return record.description;
  }
  if (record.type === "undefined") {
    return "undefined";
  }
  return stringifyValue(value);
}

function eventFromProtocol(process: ProcessScope, event: JsonRpcEvent): DiagnosticEvent | undefined {
  const params = typeof event.params === "object" && event.params !== null
    ? (event.params as Record<string, unknown>)
    : {};
  const now = new Date().toISOString();

  if (event.method === "Runtime.consoleAPICalled") {
    const args = Array.isArray(params.args) ? params.args : [];
    return {
      process,
      observedAt: now,
      kind: "console",
      level: typeof params.type === "string" ? params.type : "log",
      message: args.map(formatConsoleArgument).join(" "),
      data: { type: params.type },
    };
  }

  if (event.method === "Runtime.exceptionThrown") {
    const details = params.exceptionDetails;
    return {
      process,
      observedAt: now,
      kind: "exception",
      level: "error",
      message: stringifyValue(details),
      data: details,
    };
  }

  if (event.method === "Log.entryAdded") {
    const entry = params.entry;
    const record = typeof entry === "object" && entry !== null
      ? (entry as Record<string, unknown>)
      : {};
    return {
      process,
      observedAt: now,
      kind: "console",
      level: typeof record.level === "string" ? record.level : "log",
      message: typeof record.text === "string" ? record.text : stringifyValue(record),
      data: record,
    };
  }

  if (event.method === "protocolError") {
    return {
      process,
      observedAt: now,
      kind: "protocol",
      level: "error",
      message: stringifyValue(params),
      data: params,
    };
  }

  return undefined;
}

export class DiagnosticSession {
  private connection?: JsonRpcConnection;
  private websocketUrl?: string;
  private endpoint?: EndpointConfig;
  private selectedTarget?: TargetInfo;
  private status: PublicSessionStatus = "unconfigured";
  private lastConnectedAt?: string;
  private lastDisconnectedAt?: string;
  private lastDisconnectReason?: string;
  private error?: ReturnType<typeof toDiagnosticError>;
  readonly events: EventBuffer;

  constructor(private readonly options: SessionOptions) {
    this.events = new EventBuffer(options.maxLogEvents, options.maxLogBytes);
  }

  get isConnected(): boolean {
    return this.connection?.isOpen === true;
  }

  get endpointConfig(): EndpointConfig | undefined {
    return this.endpoint;
  }

  setEndpoint(endpoint: EndpointConfig | undefined): void {
    const changed = this.endpoint?.url !== endpoint?.url;
    this.endpoint = endpoint;
    if (!endpoint) {
      this.status = "unconfigured";
      this.error = undefined;
      this.selectedTarget = undefined;
      this.websocketUrl = undefined;
    } else if (changed || !this.isConnected) {
      this.status = "offline";
      this.error = undefined;
      if (changed) {
        this.selectedTarget = undefined;
        this.websocketUrl = undefined;
      }
    }
  }

  setError(error: ReturnType<typeof toDiagnosticError>): void {
    this.error = error;
    this.status = this.endpoint ? "offline" : "unconfigured";
  }

  clearTargetSelection(): void {
    this.selectedTarget = undefined;
  }

  async connect(endpoint: EndpointConfig, websocketUrl: string, target?: TargetInfo): Promise<void> {
    if (
      this.connection?.isOpen &&
      this.endpoint?.url === endpoint.url &&
      this.selectedTarget?.id === target?.id &&
      this.websocketUrl === websocketUrl
    ) {
      this.endpoint = endpoint;
      this.status = "online";
      this.error = undefined;
      return;
    }

    await this.close("Session replaced");
    this.endpoint = endpoint;
    this.selectedTarget = target;

    let connection!: JsonRpcConnection;
    connection = new JsonRpcConnection({
      requestTimeoutMs: this.options.requestTimeoutMs,
      maxMessageBytes: this.options.maxProtocolMessageBytes,
      onEvent: (event) => this.handleEvent(event),
      onClose: (reason) => this.handleClose(connection, reason),
    });
    try {
      await connection.connect(websocketUrl);
      this.connection = connection;
      this.websocketUrl = websocketUrl;
      await this.enableCoreDomains(connection);
      if (this.connection !== connection || !connection.isOpen) {
        throw new DiagnosticException("SESSION_DISCONNECTED", "协议域初始化期间连接已断开", {
          retryable: true,
        });
      }
      this.status = "online";
      this.error = undefined;
      this.lastConnectedAt = new Date().toISOString();
      this.events.add({
        process: this.options.process,
        targetId: target?.id,
        observedAt: new Date().toISOString(),
        kind: "connection",
        level: "info",
        message: "Session connected",
      });
    } catch (error) {
      await connection.close();
      this.connection = undefined;
      this.websocketUrl = undefined;
      this.selectedTarget = undefined;
      this.status = "offline";
      this.error = toDiagnosticError(error, "SESSION_DISCONNECTED");
      this.lastDisconnectedAt = new Date().toISOString();
      this.lastDisconnectReason = this.error.message;
      throw error;
    }
  }

  async close(reason = "Session closed"): Promise<void> {
    const connection = this.connection;
    this.connection = undefined;
    this.websocketUrl = undefined;
    this.selectedTarget = undefined;
    if (!connection) {
      this.status = this.endpoint ? "offline" : "unconfigured";
      return;
    }
    await connection.close();
    this.status = this.endpoint ? "offline" : "unconfigured";
    this.lastDisconnectedAt = new Date().toISOString();
    this.lastDisconnectReason = reason;
  }

  snapshot(): SessionSnapshot {
    return {
      configured: this.endpoint !== undefined,
      online: this.status === "online" && this.isConnected,
      status: this.status,
      endpoint: this.endpoint?.url,
      endpointSource: this.endpoint?.source,
      selectedTarget: this.selectedTarget,
      lastConnectedAt: this.lastConnectedAt,
      lastDisconnectedAt: this.lastDisconnectedAt,
      lastDisconnectReason: this.lastDisconnectReason,
      eventCount: this.events.size,
      error: this.error,
    };
  }

  private async enableCoreDomains(connection: JsonRpcConnection): Promise<void> {
    const domains = this.options.process === "renderer"
      ? ["Runtime.enable", "Log.enable"]
      : ["Runtime.enable"];
    for (const method of domains) {
      try {
        await connection.request(method);
      } catch (error) {
        if (!connection.isOpen) {
          throw error;
        }
        this.events.add({
          process: this.options.process,
          targetId: this.selectedTarget?.id,
          observedAt: new Date().toISOString(),
          kind: "protocol",
          level: "warn",
          message: `协议域启用失败：${method}`,
          data: toDiagnosticError(error),
        });
      }
    }
  }

  private handleEvent(event: JsonRpcEvent): void {
    const normalized = eventFromProtocol(this.options.process, event);
    if (normalized) {
      normalized.targetId = this.selectedTarget?.id;
      this.events.add(normalized);
    }
  }

  private handleClose(connection: JsonRpcConnection, reason: string): void {
    if (this.connection !== connection) {
      return;
    }
    const targetId = this.selectedTarget?.id;
    this.connection = undefined;
    this.websocketUrl = undefined;
    this.selectedTarget = undefined;
    this.status = this.endpoint ? "offline" : "unconfigured";
    this.lastDisconnectedAt = new Date().toISOString();
    this.lastDisconnectReason = reason;
    this.events.add({
      process: this.options.process,
      targetId,
      observedAt: new Date().toISOString(),
      kind: "connection",
      level: "error",
      message: reason,
    });
    this.options.onDisconnected?.();
  }
}
