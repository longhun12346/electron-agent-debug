import { randomBytes } from "node:crypto";
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { renderAxTree, type AxNode } from "../ax-tree.js";
import type { RuntimeConfig } from "../config.js";
import { DiagnosticException, errorResult, toDiagnosticError } from "../errors.js";
import { evaluateExpression, type EvaluateResult } from "../evaluate.js";
import { clickRef, RefRegistry, typeRef, type ClickInput, type ElementTarget, type TypeInput } from "../interaction.js";
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
  utility: DiagnosticSession;
  listEvents(input: LogsInput): DiagnosticEvent[];
  /** Whether the event is older than its channel's latest connection (replayed history or an earlier connection). */
  isBeforeAttach(event: DiagnosticEvent): boolean;
  lastSeq(): number;
  /** Whether events the wait asks about may have been evicted from a full buffer. */
  logGap(process: LogsInput["process"], afterSeq: number | undefined): boolean;
}

export interface EvaluateInput {
  scope: EvaluateScope;
  expression: string;
  awaitPromise?: boolean;
  timeoutMs?: number;
  maxResultBytes?: number;
}

export type WaitCondition =
  | { kind: "log"; contains: string; process?: ProcessScope | "all"; level?: string; afterSeq?: number; sinceAttach?: boolean }
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

export interface ScreenshotInput {
  format?: "png" | "jpeg";
  quality?: number;
  maxWidth?: number;
}

interface Viewport {
  pageX?: number;
  pageY?: number;
  clientWidth: number;
  clientHeight: number;
}

interface LayoutMetrics {
  cssVisualViewport?: Viewport;
  visualViewport?: Viewport;
}

interface CaptureSize {
  deviceScaleFactor: number;
  clip?: { x: number; y: number; width: number; height: number; scale: number };
}

// Read from the image itself: Chromium rounds a fractional viewport its own way.
function imageSize(image: Buffer, format: "png" | "jpeg"): { width?: number; height?: number } {
  if (format === "png") {
    return image.length >= 24 ? { width: image.readUInt32BE(16), height: image.readUInt32BE(20) } : {};
  }
  for (let offset = 2; offset + 9 < image.length;) {
    if (image[offset] !== 0xff) return {};
    const marker = image[offset + 1]!;
    // Start-of-frame markers carry the size; C4, C8 and CC are other segments with the same prefix.
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: image.readUInt16BE(offset + 5), width: image.readUInt16BE(offset + 7) };
    }
    offset += 2 + image.readUInt16BE(offset + 2);
  }
  return {};
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function clamp(value: number | undefined, fallback: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value ?? fallback, minimum), maximum);
}

export class Inspector {
  readonly refs = new RefRegistry();

  constructor(private readonly deps: InspectorDependencies) {}

  async click(input: ClickInput): Promise<Result<Record<string, unknown>>> {
    return this.interact(input, (afterSeq) => clickRef(this.deps.renderer, this.refs, input).then((data) => ({ ...data, afterSeq })));
  }

  async type(input: TypeInput): Promise<Result<Record<string, unknown>>> {
    return this.interact(input, (afterSeq) => typeRef(this.deps.renderer, this.refs, input).then((data) => ({ ...data, afterSeq })));
  }

  // Reads the page's accessibility tree into the ref registry without rendering it, so an element given by role and
  // name is looked up in the whole page, not only the part a size-limited snapshot shows. It counts as the latest
  // snapshot: refs it assigns are the same a snapshot would show.
  private async indexPage(): Promise<void> {
    const response = await this.deps.renderer.request(
      "Accessibility.getFullAXTree",
      {},
      Math.max(this.deps.config.requestTimeoutMs, 10_000),
    ) as { nodes?: AxNode[] };
    const target = this.deps.renderer.snapshot().selectedTarget;
    if (!target) return;
    const nodes = response.nodes ?? [];
    renderAxTree(nodes, nodes.length, this.refs.begin(target.id));
  }

  // Input changes the app's state just as evaluated code can, so it is switched off by the same setting. afterSeq is
  // the timeline position before the input: pass it to electron_wait_for or electron_logs to see what followed.
  private async interact(
    target: ElementTarget,
    run: (afterSeq: number) => Promise<Record<string, unknown>>,
  ): Promise<Result<Record<string, unknown>>> {
    if (!this.deps.config.allowEval) {
      return errorResult({
        code: "INTERACTION_NOT_ALLOWED",
        message: "宿主已通过 ELECTRON_DEBUG_ALLOW_EVAL=0 禁用执行代码，点击和输入随之禁用",
        retryable: false,
      });
    }
    try {
      if (!("ref" in target)) await this.indexPage();
      const afterSeq = this.deps.lastSeq();
      const page = this.deps.renderer.snapshot().selectedTarget;
      return { ok: true, data: { ...(await run(afterSeq)), targetId: page?.id } };
    } catch (error) {
      return errorResult(toDiagnosticError(error, "INTERACTION_FAILED"));
    }
  }

  async evaluate(input: EvaluateInput): Promise<Result<EvaluateResult & { scope: EvaluateScope; targetId?: string }>> {
    const session = input.scope === "main"
      ? this.deps.main
      : input.scope === "utility"
        ? this.deps.utility
        : this.deps.renderer;
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

  /** What a timed-out log wait can say about why nothing matched: a channel that is offline, or evicted events. */
  private logWaitDetails(condition: Extract<WaitCondition, { kind: "log" }>): Record<string, unknown> {
    const scope = condition.process ?? "all";
    const sessions: Array<[ProcessScope, DiagnosticSession]> = [
      ["main", this.deps.main], ["renderer", this.deps.renderer], ["utility", this.deps.utility],
    ];
    const offlineChannels = sessions
      .filter(([name]) => scope === "all" || scope === name)
      .filter(([, session]) => {
        const snapshot = session.snapshot();
        return snapshot.configured && !snapshot.online;
      })
      .map(([name]) => name);
    const gap = this.deps.logGap(condition.process, condition.afterSeq);
    if (offlineChannels.length === 0 && !gap) return {};
    return {
      ...(offlineChannels.length > 0 ? { offlineChannels } : {}),
      ...(gap ? { gap: true } : {}),
      hint: "日志条件没有命中，但" + (offlineChannels.length > 0 ? `通道 ${offlineChannels.join("、")} 已离线（先用 electron_status 看原因）` : "") +
        (offlineChannels.length > 0 && gap ? "，且" : "") +
        (gap ? "缓冲区满过、所请求范围内的事件可能已被丢弃（缩短取证间隔，或调大 ELECTRON_DEBUG_MAX_LOG_EVENTS）" : "") + "。",
    };
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
          sinceAttach: condition.sinceAttach,
          limit: 10_000,
        }).find((candidate) => candidate.message.includes(condition.contains));
        if (event) {
          // An event from before the channel's latest connection (replayed history, or an earlier connection) is
          // often the same text from an earlier run of the step, so a fresh failure or success is not proven by it.
          if (this.deps.isBeforeAttach(event)) {
            return {
              ok: true,
              data: {
                matched: true, condition: "log", event, elapsedMs, beforeAttach: true,
                hint: "命中的是该通道最近一次连接之前的事件（attach 时重放的应用历史，或之前连接期间的输出），可能来自上一轮操作。要等新事件，传 sinceAttach: true 或操作前记下的 afterSeq。",
              },
            };
          }
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
          details: {
            condition: condition.kind, elapsedMs: Date.now() - startedAt, lastSeq: this.deps.lastSeq(), lastError,
            ...(condition.kind === "log" ? this.logWaitDetails(condition) : {}),
          },
        });
      }
      await sleep(Math.max(1, Math.min(intervalMs, timeoutMs - (Date.now() - startedAt))));
    }
  }

  async screenshot(input: ScreenshotInput): Promise<Result<Record<string, unknown>>> {
    const format = input.format ?? "png";
    try {
      const size = await this.captureSize(input.maxWidth);
      const response = await this.deps.renderer.request("Page.captureScreenshot", {
        format,
        ...(format === "jpeg" ? { quality: clamp(input.quality, 80, 1, 100) } : {}),
        ...(size?.clip ? { clip: size.clip } : {}),
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
      // Clearing old files is housekeeping: a file that is busy (a viewer holds it open on Windows) must not turn a
      // screenshot that was taken into a failure.
      await this.pruneScreenshots(directory).catch(() => undefined);
      const target = this.deps.renderer.snapshot().selectedTarget;
      return {
        ok: true,
        data: {
          path: file,
          bytes: image.length,
          format,
          ...imageSize(image, format),
          ...(size ? { deviceScaleFactor: size.deviceScaleFactor } : {}),
          targetId: target?.id,
          url: await this.currentUrl(),
        },
      };
    } catch (error) {
      const diagnostic = toDiagnosticError(error, "SCREENSHOT_FAILED");
      if (diagnostic.details?.reason !== "timeout") {
        return errorResult(diagnostic);
      }
      return errorResult({
        ...diagnostic,
        message: `${diagnostic.message}；窗口被隐藏或最小化时 Chromium 不会响应截图，请先显示窗口`,
      });
    }
  }

  async domSnapshot(input: { maxNodes?: number; interactive?: boolean; maxText?: number }): Promise<Result<Record<string, unknown>>> {
    try {
      const response = await this.deps.renderer.request(
        "Accessibility.getFullAXTree",
        {},
        Math.max(this.deps.config.requestTimeoutMs, 10_000),
      ) as { nodes?: AxNode[] };
      const target = this.deps.renderer.snapshot().selectedTarget;
      const assignRef = target ? this.refs.begin(target.id) : undefined;
      const rendering = renderAxTree(response.nodes ?? [], clamp(input.maxNodes, 400, 1, 2_000), assignRef, {
        interactive: input.interactive === true,
        maxText: clamp(input.maxText, 120, 20, 2_000),
      });
      return { ok: true, data: { targetId: target?.id, url: await this.currentUrl(), ...rendering } };
    } catch (error) {
      return errorResult(toDiagnosticError(error, "SNAPSHOT_FAILED"));
    }
  }

  // A high-DPI screen doubles or triples both sides of a screenshot, and the agent pays for every pixel it reads. By
  // default the image is taken at the page's CSS size (what a 1x screen shows); maxWidth shrinks it further, and a
  // maxWidth above the CSS width keeps up to the full device resolution. Without layout metrics the capture is left
  // as Chromium takes it.
  private async captureSize(maxWidth: number | undefined): Promise<CaptureSize | undefined> {
    let metrics: LayoutMetrics;
    try {
      metrics = await this.deps.renderer.request("Page.getLayoutMetrics", {}) as LayoutMetrics;
    } catch (error) {
      // A crashed page or one blocked by a dialog would only make the capture itself wait for its longer timeout.
      if (error instanceof DiagnosticException &&
        (error.diagnostic.code === "TARGET_CRASHED" || error.diagnostic.details?.reason === "timeout")) {
        throw error;
      }
      return undefined;
    }
    const css = metrics.cssVisualViewport;
    const device = metrics.visualViewport;
    if (!css || !device || !(css.clientWidth > 0) || !(css.clientHeight > 0)) return undefined;
    const deviceScaleFactor = device.clientWidth > 0 ? device.clientWidth / css.clientWidth : 1;
    const deviceWidth = css.clientWidth * deviceScaleFactor;
    const width = Math.max(1, Math.min(maxWidth ?? css.clientWidth, deviceWidth));
    // clip.scale is relative to the device resolution.
    const scale = width / deviceWidth;
    const result = { deviceScaleFactor: Math.round(deviceScaleFactor * 100) / 100 };
    if (scale > 0.999) return result;
    return {
      ...result,
      clip: { x: css.pageX ?? 0, y: css.pageY ?? 0, width: css.clientWidth, height: css.clientHeight, scale },
    };
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
