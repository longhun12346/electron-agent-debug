import { randomBytes } from "node:crypto";
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { renderAxTree, type AxNode } from "../ax-tree.js";
import type { RuntimeConfig } from "../config.js";
import { DiagnosticException, errorResult, toDiagnosticError } from "../errors.js";
import { evaluateExpression, type EvaluateResult } from "../evaluate.js";
import type {
  DiagnosticEvent,
  EvaluateScope,
  LogsInput,
  ProcessScope,
  Result,
} from "../types.js";
import type { DiagnosticSession } from "./diagnostic-session.js";

export interface InspectorDependencies {
  config: RuntimeConfig;
  main: DiagnosticSession;
  renderer: DiagnosticSession;
  listEvents(input: LogsInput): DiagnosticEvent[];
  lastSeq(): number;
}

export interface EvaluateInput {
  scope: EvaluateScope;
  expression: string;
  awaitPromise?: boolean;
  timeoutMs?: number;
  maxResultBytes?: number;
}

export type WaitCondition =
  | { kind: "log"; contains: string; process?: ProcessScope | "all"; level?: string; afterSeq?: number }
  | { kind: "expression"; scope: EvaluateScope; expression: string };

export interface WaitInput {
  condition: WaitCondition;
  timeoutMs?: number;
  intervalMs?: number;
}

const defaultEvaluateTimeoutMs = 3_000;
const maxEvaluateTimeoutMs = 30_000;
const defaultResultBytes = 65_536;
const maxResultBytes = 1_048_576;
const defaultWaitTimeoutMs = 10_000;
const maxWaitTimeoutMs = 120_000;
const retainedScreenshots = 50;

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function clamp(value: number | undefined, fallback: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value ?? fallback, minimum), maximum);
}

export class Inspector {
  constructor(private readonly deps: InspectorDependencies) {}

  async evaluate(input: EvaluateInput): Promise<Result<EvaluateResult & { scope: EvaluateScope; targetId?: string }>> {
    const session = input.scope === "main" ? this.deps.main : this.deps.renderer;
    if (!this.deps.config.allowEval) {
      return errorResult({
        code: "EVALUATION_NOT_ALLOWED",
        message: "宿主已通过 ELECTRON_DEBUG_ALLOW_EVAL=0 禁用执行代码",
        retryable: false,
        details: { scope: input.scope },
      });
    }

    try {
      const result = await evaluateExpression(session, {
        expression: input.expression,
        awaitPromise: input.awaitPromise ?? true,
        timeoutMs: clamp(input.timeoutMs, defaultEvaluateTimeoutMs, 100, maxEvaluateTimeoutMs),
        maxResultBytes: clamp(input.maxResultBytes, defaultResultBytes, 256, maxResultBytes),
      });
      return {
        ok: true,
        data: { scope: input.scope, targetId: session.snapshot().selectedTarget?.id, ...result },
      };
    } catch (error) {
      return errorResult(toDiagnosticError(error, "EVALUATION_FAILED"));
    }
  }

  async waitFor(input: WaitInput): Promise<Result<Record<string, unknown>>> {
    const timeoutMs = clamp(input.timeoutMs, defaultWaitTimeoutMs, 100, maxWaitTimeoutMs);
    const intervalMs = clamp(input.intervalMs, 200, 50, 5_000);
    const startedAt = Date.now();
    const condition = input.condition;
    let lastError: unknown;

    for (;;) {
      const elapsedMs = Date.now() - startedAt;
      if (condition.kind === "log") {
        const event = this.deps.listEvents({
          process: condition.process,
          level: condition.level,
          afterSeq: condition.afterSeq,
          limit: 10_000,
        }).find((candidate) => candidate.message.includes(condition.contains));
        if (event) {
          return { ok: true, data: { matched: true, condition: "log", event, elapsedMs } };
        }
      } else {
        const remaining = timeoutMs - elapsedMs;
        const result = await this.evaluate({
          scope: condition.scope,
          expression: condition.expression,
          timeoutMs: Math.min(2_000, Math.max(remaining, 100)),
        });
        if (!result.ok && result.error.code === "EVALUATION_NOT_ALLOWED") {
          return result;
        }
        if (result.ok) {
          lastError = undefined;
          if (result.data.value) {
            return {
              ok: true,
              data: { matched: true, condition: "expression", value: result.data.value, elapsedMs },
            };
          }
        } else {
          lastError = result.error;
        }
      }

      if (Date.now() - startedAt >= timeoutMs) {
        return errorResult({
          code: "WAIT_TIMEOUT",
          message: `等待条件未在 ${timeoutMs}ms 内满足`,
          retryable: true,
          details: { condition: condition.kind, elapsedMs: Date.now() - startedAt, lastSeq: this.deps.lastSeq(), lastError },
        });
      }
      await sleep(intervalMs);
    }
  }

  async screenshot(input: { format?: "png" | "jpeg"; quality?: number }): Promise<Result<Record<string, unknown>>> {
    const format = input.format ?? "png";
    try {
      const response = await this.deps.renderer.request("Page.captureScreenshot", {
        format,
        ...(format === "jpeg" ? { quality: clamp(input.quality, 80, 1, 100) } : {}),
      }, 15_000) as { data?: string };
      if (typeof response.data !== "string") {
        throw new DiagnosticException("PROTOCOL_ERROR", "截图响应缺少图像数据");
      }
      const image = Buffer.from(response.data, "base64");
      const directory = this.deps.config.outputDir ?? path.join(os.tmpdir(), "electron-agent-debug");
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const file = path.join(
        directory,
        `screenshot-${Date.now()}-${randomBytes(3).toString("hex")}.${format === "jpeg" ? "jpg" : "png"}`,
      );
      await writeFile(file, image, { mode: 0o600 });
      await this.pruneScreenshots(directory);
      const target = this.deps.renderer.snapshot().selectedTarget;
      return {
        ok: true,
        data: { path: file, bytes: image.length, format, targetId: target?.id, url: await this.currentUrl() },
      };
    } catch (error) {
      const diagnostic = toDiagnosticError(error, "SCREENSHOT_FAILED");
      if (diagnostic.message.includes("超时")) {
        diagnostic.message += "；窗口被隐藏或最小化时 Chromium 不会响应截图，请先显示窗口";
      }
      return errorResult(diagnostic);
    }
  }

  async domSnapshot(input: { maxNodes?: number }): Promise<Result<Record<string, unknown>>> {
    try {
      const response = await this.deps.renderer.request(
        "Accessibility.getFullAXTree",
        {},
        Math.max(this.deps.config.requestTimeoutMs, 10_000),
      ) as { nodes?: AxNode[] };
      const rendering = renderAxTree(response.nodes ?? [], clamp(input.maxNodes, 400, 1, 2_000));
      const target = this.deps.renderer.snapshot().selectedTarget;
      return { ok: true, data: { targetId: target?.id, url: await this.currentUrl(), ...rendering } };
    } catch (error) {
      return errorResult(toDiagnosticError(error, "SNAPSHOT_FAILED"));
    }
  }

  private async currentUrl(): Promise<string | undefined> {
    const fallback = this.deps.renderer.snapshot().selectedTarget?.url;
    try {
      const history = await this.deps.renderer.request("Page.getNavigationHistory", {}) as {
        currentIndex?: number;
        entries?: Array<{ url?: string }>;
      };
      const url = history.entries?.[history.currentIndex ?? -1]?.url;
      return typeof url === "string" ? url : fallback;
    } catch {
      return fallback;
    }
  }

  private async pruneScreenshots(directory: string): Promise<void> {
    const names = (await readdir(directory)).filter((name) => /^screenshot-\d+-[0-9a-f]+\.(png|jpg)$/.test(name)).sort();
    for (const name of names.slice(0, Math.max(names.length - retainedScreenshots, 0))) {
      await rm(path.join(directory, name), { force: true });
    }
  }
}
