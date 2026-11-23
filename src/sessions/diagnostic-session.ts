import { EventBuffer, sessionConnectedMessage, type EventSequence } from "../events/event-buffer.js";
import { blockingDialogHint, DialogTracker, dialogBinding, dialogMessage, instrumentDialogsScript } from "../dialogs.js";
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
  sequence?: EventSequence;
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

const maxStackFrames = 10;

// Chromium keeps the debugging connection of a crashed page open, but the page answers nothing until it is reloaded.
const targetCrashedMessage = "目标页面已崩溃，重新加载后才会恢复（Inspector.targetCrashed）";

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

// The protocol counts lines and columns from 0; stacks and editors count from 1.
function position(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value + 1 : 1;
}

function formatFrames(stackTrace: unknown): string[] {
  const frames = asRecord(stackTrace).callFrames;
  if (!Array.isArray(frames)) {
    return [];
  }
  const lines = frames.slice(0, maxStackFrames).map((value) => {
    const frame = asRecord(value);
    const name = typeof frame.functionName === "string" && frame.functionName !== "" ? frame.functionName : "<anonymous>";
    const url = typeof frame.url === "string" && frame.url !== "" ? frame.url : "<unknown>";
    return `    at ${name} (${url}:${position(frame.lineNumber)}:${position(frame.columnNumber)})`;
  });
  if (frames.length > maxStackFrames) {
    lines.push(`    … ${frames.length - maxStackFrames} more frames`);
  }
  return lines;
}

function eventFromProtocol(process: ProcessScope, event: JsonRpcEvent): DiagnosticEvent | undefined {
  const params = typeof event.params === "object" && event.params !== null
    ? (event.params as Record<string, unknown>)
    : {};
  const now = new Date().toISOString();

  if (event.method === "Runtime.consoleAPICalled") {
    const args = Array.isArray(params.args) ? params.args : [];
    // Only calls that exist to show a stack carry one; every other console call would repeat its call site.
    const frames = params.type === "trace" || params.type === "assert" ? formatFrames(params.stackTrace) : [];
    return {
      process,
      observedAt: now,
      kind: "console",
      level: typeof params.type === "string" ? params.type : "log",
      message: [args.map(formatConsoleArgument).join(" "), ...frames].join("\n"),
      data: { type: params.type },
    };
  }

  if (event.method === "Runtime.exceptionThrown") {
    const details = asRecord(params.exceptionDetails);
    const exception = asRecord(details.exception);
    const thrown = typeof exception.description === "string"
      ? exception.description
      : "value" in exception ? formatConsoleArgument(exception) : undefined;
    const summary = [details.text, thrown].filter((part) => typeof part === "string" && part !== "").join(" ");
    // An Error's description already ends with its stack; other thrown values only have the protocol frames.
    const frames = thrown !== undefined && /\n\s+at /u.test(thrown) ? [] : formatFrames(details.stackTrace);
    return {
      process,
      observedAt: now,
      kind: "exception",
      level: "error",
      message: [summary || "Uncaught exception", ...frames].join("\n"),
      data: typeof details.url === "string" && details.url !== ""
        ? { url: details.url, line: position(details.lineNumber), column: position(details.columnNumber) }
        : undefined,
    };
  }

  if (event.method === "Log.entryAdded") {
    const record = asRecord(params.entry);
    const data: Record<string, unknown> = {};
    for (const key of ["source", "url"]) {
      if (typeof record[key] === "string" && record[key] !== "") data[key] = record[key];
    }
    return {
      process,
      observedAt: now,
      kind: "console",
      level: typeof record.level === "string" ? record.level : "log",
      message: typeof record.text === "string" ? record.text : stringifyValue(record),
      data,
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
  private crashedAt?: string;
  private error?: ReturnType<typeof toDiagnosticError>;
  readonly events: EventBuffer;
  readonly dialogs: DialogTracker;

  constructor(private readonly options: SessionOptions) {
    this.events = new EventBuffer(options.maxLogEvents, options.maxLogBytes, options.sequence);
    this.dialogs = new DialogTracker(options.process);
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
    this.crashedAt = undefined;
    this.dialogs.clear();

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
        message: sessionConnectedMessage,
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
    this.crashedAt = undefined;
    this.dialogs.clear();
    if (!connection) {
      this.status = this.endpoint ? "offline" : "unconfigured";
      return;
    }
    await connection.close();
    this.status = this.endpoint ? "offline" : "unconfigured";
    this.lastDisconnectedAt = new Date().toISOString();
    this.lastDisconnectReason = reason;
  }

  async request(method: string, params?: unknown, timeoutMs?: number): Promise<unknown> {
    if (!this.connection?.isOpen) {
      throw new DiagnosticException("SESSION_DISCONNECTED", `${this.options.process} 通道当前不可用`, {
        retryable: true,
        hint: this.disconnectedHint(),
        ...(this.lastDisconnectReason !== undefined ? { details: { lastDisconnectReason: this.lastDisconnectReason } } : {}),
      });
    }
    if (this.crashedAt !== undefined) {
      // Without this the request would only fail after its timeout.
      throw new DiagnosticException("TARGET_CRASHED", targetCrashedMessage, {
        retryable: true,
        details: { crashedAt: this.crashedAt },
      });
    }
    try {
      return await this.connection.request(method, params, timeoutMs);
    } catch (error) {
      // A request that times out while a dialog is waiting for the user timed out because of the dialog.
      const dialog = this.dialogs.blocking;
      if (dialog === undefined || !(error instanceof DiagnosticException) || error.diagnostic.details?.reason !== "timeout") {
        throw error;
      }
      throw new DiagnosticException(error.diagnostic.code, error.diagnostic.message, {
        retryable: true,
        hint: blockingDialogHint,
        details: { ...error.diagnostic.details, dialog },
        cause: error,
      });
    }
  }

  /**
   * Main process only: report native dialogs by wrapping Electron's `dialog` functions (see dialogs.ts). This runs
   * code in the app, so the caller only does it when evaluation is allowed. A failure leaves a warning in the timeline.
   */
  async instrumentDialogs(): Promise<void> {
    const connection = this.connection;
    if (!connection?.isOpen) return;
    try {
      await connection.request("Runtime.addBinding", { name: dialogBinding });
      const response = await connection.request("Runtime.evaluate", {
        expression: instrumentDialogsScript,
        awaitPromise: true,
        returnByValue: true,
      }, 3_000) as { result?: { value?: unknown }; exceptionDetails?: { text?: string } };
      if (response.exceptionDetails) {
        throw new Error(response.exceptionDetails.text ?? "instrumentation threw");
      }
      const state = JSON.parse(String(response.result?.value ?? "{}")) as { open?: unknown[] };
      // Dialogs opened before this attach (seen by an earlier attach of the wrapper) are reported again.
      for (const entry of state.open ?? []) {
        this.recordDialog(this.dialogs.native(JSON.stringify({ ...(entry as object), event: "open" })));
      }
    } catch (error) {
      if (!connection.isOpen) return;
      this.events.add({
        process: this.options.process,
        observedAt: new Date().toISOString(),
        kind: "protocol",
        level: "warn",
        message: "原生对话框监测未启用，status 不会报告主进程打开的对话框",
        data: toDiagnosticError(error),
      });
    }
  }

  snapshot(): SessionSnapshot {
    const crashed = this.crashedAt !== undefined;
    return {
      configured: this.endpoint !== undefined,
      online: this.status === "online" && this.isConnected && !crashed,
      status: crashed ? "offline" : this.status,
      endpoint: this.endpoint?.url,
      endpointSource: this.endpoint?.source,
      selectedTarget: this.selectedTarget,
      lastConnectedAt: this.lastConnectedAt,
      lastDisconnectedAt: this.lastDisconnectedAt,
      lastDisconnectReason: this.lastDisconnectReason,
      eventCount: this.events.size,
      ...(this.dialogs.list.length > 0 ? { dialogs: this.dialogs.list } : {}),
      error: crashed
        ? {
          code: "TARGET_CRASHED",
          message: targetCrashedMessage,
          retryable: true,
          details: { crashedAt: this.crashedAt },
        }
        : this.error,
    };
  }

  private async enableCoreDomains(connection: JsonRpcConnection): Promise<void> {
    // Page.enable only brings the JavaScript dialog events. A dialog already open before the attach is not announced.
    const domains = this.options.process === "renderer"
      ? ["Runtime.enable", "Log.enable", "Inspector.enable", "Page.enable"]
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
    if (event.method === "Inspector.targetCrashed") {
      this.crashedAt = new Date().toISOString();
      this.events.add({
        process: this.options.process,
        targetId: this.selectedTarget?.id,
        observedAt: this.crashedAt,
        kind: "exception",
        level: "error",
        message: "Target crashed (Inspector.targetCrashed): the page does not respond until it is reloaded",
      });
      return;
    }
    if (event.method === "Inspector.targetReloadedAfterCrash") {
      this.crashedAt = undefined;
      this.events.add({
        process: this.options.process,
        targetId: this.selectedTarget?.id,
        observedAt: new Date().toISOString(),
        kind: "connection",
        level: "info",
        message: "Target reloaded after crash",
      });
      return;
    }
    if (event.method === "Page.javascriptDialogOpening") {
      this.recordDialog({
        event: "open",
        dialog: this.dialogs.javascriptOpened(asRecord(event.params), this.selectedTarget?.id),
      });
      return;
    }
    if (event.method === "Page.javascriptDialogClosed") {
      const dialog = this.dialogs.javascriptClosed();
      if (dialog) this.recordDialog({ event: "close", dialog });
      return;
    }
    if (event.method === "Runtime.bindingCalled" && asRecord(event.params).name === dialogBinding) {
      this.recordDialog(this.dialogs.native(asRecord(event.params).payload));
      return;
    }
    const normalized = eventFromProtocol(this.options.process, event);
    if (normalized) {
      normalized.targetId = this.selectedTarget?.id;
      this.events.add(normalized);
    }
  }

  private recordDialog(change: ReturnType<DialogTracker["native"]>): void {
    if (!change) return;
    this.events.add({
      process: this.options.process,
      targetId: change.dialog.targetId,
      observedAt: new Date().toISOString(),
      kind: "dialog",
      level: change.event === "open" ? "warn" : "info",
      message: dialogMessage(change.event, change.dialog),
      data: change.dialog,
    });
  }

  private disconnectedHint(): string {
    if (this.endpoint === undefined) {
      return "还没有连接这个通道，先调用 electron_attach。";
    }
    if (this.options.process === "renderer") {
      return "选中的页面已关闭、被替换或应用已退出；用 electron_targets 重新发现并选择页面，应用重启过则重新 electron_attach。";
    }
    return "应用可能已退出或重启；重启后端口可能变化，用新的 endpoint 重新 electron_attach。";
  }

  private handleClose(connection: JsonRpcConnection, reason: string): void {
    if (this.connection !== connection) {
      return;
    }
    const targetId = this.selectedTarget?.id;
    this.connection = undefined;
    this.websocketUrl = undefined;
    this.selectedTarget = undefined;
    this.crashedAt = undefined;
    this.dialogs.clear();
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
