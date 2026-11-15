import WebSocket from "ws";
import { DiagnosticException } from "../errors.js";

export interface JsonRpcEvent {
  method: string;
  params?: unknown;
}

export interface JsonRpcConnectionOptions {
  requestTimeoutMs: number;
  maxMessageBytes: number;
  onEvent?: (event: JsonRpcEvent) => void;
  onClose?: (reason: string) => void;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
  timer: NodeJS.Timeout;
}

interface JsonRpcResponse {
  id?: number;
  result?: unknown;
  error?: {
    code?: number;
    message?: string;
    data?: unknown;
  };
}

export class JsonRpcConnection {
  private readonly pending = new Map<number, PendingRequest>();
  private nextId = 1;
  private socket?: WebSocket;
  private closed = false;

  constructor(private readonly options: JsonRpcConnectionOptions) {}

  get isOpen(): boolean {
    return this.socket?.readyState === WebSocket.OPEN && !this.closed;
  }

  async connect(url: string): Promise<void> {
    if (this.isOpen) {
      return;
    }

    this.closed = false;
    await new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(url, {
        maxPayload: this.options.maxMessageBytes,
      });
      this.socket = socket;
      let settled = false;
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          socket.close();
          reject(
            new DiagnosticException("SESSION_DISCONNECTED", "WebSocket 建连超时", {
              retryable: true,
            }),
          );
        }
      }, this.options.requestTimeoutMs);

      socket.once("open", () => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolve();
        }
      });
      socket.on("error", (error) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(
            new DiagnosticException("SESSION_DISCONNECTED", "WebSocket 建连失败", {
              retryable: true,
              cause: error,
            }),
          );
        }
      });
      socket.on("message", (data) => this.handleMessage(data.toString()));
      socket.on("close", (_code, reason) => {
        this.closed = true;
        const text = reason.toString() || "WebSocket 已关闭";
        this.rejectPending(new DiagnosticException("SESSION_DISCONNECTED", text, { retryable: true }));
        this.options.onClose?.(text);
      });
    });
  }

  async request(method: string, params?: unknown): Promise<unknown> {
    if (!this.isOpen || !this.socket) {
      throw new DiagnosticException("SESSION_DISCONNECTED", "Session 当前不可用", {
        retryable: true,
      });
    }

    const id = this.nextId++;
    const request = JSON.stringify({ id, method, params });

    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new DiagnosticException("PROTOCOL_ERROR", `协议请求超时：${method}`, {
            retryable: true,
          }),
        );
      }, this.options.requestTimeoutMs);

      this.pending.set(id, { resolve, reject, timer });
      try {
        this.socket?.send(request, (error) => {
          if (error) {
            clearTimeout(timer);
            this.pending.delete(id);
            reject(
              new DiagnosticException("SESSION_DISCONNECTED", "WebSocket 发送失败", {
                retryable: true,
                cause: error,
              }),
            );
          }
        });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(
          new DiagnosticException("SESSION_DISCONNECTED", "WebSocket 发送失败", {
            retryable: true,
            cause: error,
          }),
        );
      }
    });
  }

  async close(): Promise<void> {
    this.closed = true;
    this.rejectPending(new DiagnosticException("SESSION_DISCONNECTED", "Session 已关闭"));
    const socket = this.socket;
    this.socket = undefined;
    if (!socket || socket.readyState === WebSocket.CLOSED) {
      return;
    }

    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 250);
      socket.once("close", () => {
        clearTimeout(timer);
        resolve();
      });
      socket.close();
    });
  }

  private handleMessage(raw: string): void {
    let message: JsonRpcResponse | JsonRpcEvent;
    try {
      message = JSON.parse(raw) as JsonRpcResponse | JsonRpcEvent;
    } catch {
      this.options.onEvent?.({ method: "protocolError", params: { message: "无效 JSON" } });
      return;
    }

    if ("id" in message && typeof message.id === "number") {
      const pending = this.pending.get(message.id);
      if (!pending) {
        return;
      }
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) {
        pending.reject(
          new DiagnosticException(
            "PROTOCOL_ERROR",
            message.error.message ?? "远端协议请求失败",
            {
              details: {
                code: message.error.code,
                data: message.error.data,
              },
            },
          ),
        );
        return;
      }
      pending.resolve(message.result);
      return;
    }

    if ("method" in message && typeof message.method === "string") {
      this.options.onEvent?.({ method: message.method, params: message.params });
    }
  }

  private rejectPending(error: DiagnosticException): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pending.delete(id);
    }
  }
}
