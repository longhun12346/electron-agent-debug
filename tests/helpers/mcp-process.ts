import { once } from "node:events";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { DiagnosticEvent, StatusResult } from "../../src/types.js";

export interface JsonRpcMessage {
  id?: number;
  result?: {
    tools?: Array<{ name: string }>;
    structuredContent?: {
      ok?: boolean;
      error?: { code?: string };
      data?: Partial<StatusResult> & { events?: DiagnosticEvent[] };
    };
  };
}

export class McpProcess {
  readonly child: ChildProcessWithoutNullStreams;
  private buffer = "";
  private readonly pending = new Map<number, {
    resolve: (message: JsonRpcMessage) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
  }>();
  private failure?: Error;

  constructor(options: {
    entry?: string; cwd?: string; nodeArgs?: string[]; env?: NodeJS.ProcessEnv;
  } = {}) {
    const env = { ...process.env };
    for (const name of Object.keys(env)) {
      if (name.startsWith("ELECTRON_DEBUG_")) delete env[name];
    }
    this.child = spawn(process.execPath, [...(options.nodeArgs ?? []), options.entry ?? "dist/index.js"], {
      stdio: ["pipe", "pipe", "pipe"],
      cwd: options.cwd,
      env: { ...env, ...options.env },
    });
    this.child.once("error", (error) => this.fail(error));
    this.child.stdin.on("error", (error) => this.fail(error));
    this.child.once("exit", (code, signal) =>
      this.fail(new Error(`MCP process exited: ${code ?? signal}`)));
    this.child.stdout.on("data", (chunk: Buffer) => {
      this.buffer += chunk.toString();
      const lines = this.buffer.split("\n");
      this.buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) {
          continue;
        }
        let message: JsonRpcMessage;
        try {
          message = JSON.parse(line) as JsonRpcMessage;
        } catch {
          this.fail(new Error("MCP stdout contained invalid JSON"));
          continue;
        }
        if (typeof message.id === "number") {
          const pending = this.pending.get(message.id);
          if (pending) {
            clearTimeout(pending.timer);
            pending.resolve(message);
          }
          this.pending.delete(message.id);
        }
      }
    });
  }

  async request(id: number, method: string, params: unknown): Promise<JsonRpcMessage> {
    if (this.failure) throw this.failure;
    const response = new Promise<JsonRpcMessage>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP request timed out: ${method}`));
      }, 5_000);
      this.pending.set(id, { resolve, reject, timer });
    });
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    return response;
  }

  notify(method: string, params: unknown): void {
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
  }

  private fail(error: Error): void {
    this.failure = error;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  async waitForExit(timeoutMs = 3_000): Promise<void> {
    if (this.child.exitCode !== null || this.child.signalCode !== null) return;
    await once(this.child, "exit", { signal: AbortSignal.timeout(timeoutMs) });
  }

  async close(): Promise<void> {
    if (this.child.exitCode !== null || this.child.signalCode !== null) {
      return;
    }
    const exited = once(this.child, "exit");
    this.child.kill();
    await exited.catch(() => undefined);
  }
}
