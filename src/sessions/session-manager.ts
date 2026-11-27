import {
  readRuntimeConfig,
  resolveEndpoint,
  type RuntimeConfig,
} from "../config.js";
import { discoverMain, discoverRenderer, pageTargets } from "../discovery.js";
import { EventBuffer, EventSequence } from "../events/event-buffer.js";
import { DiagnosticException, errorResult, toDiagnosticError } from "../errors.js";
import { publicTarget } from "../targets/output.js";
import { selectTarget, type TargetSelector } from "../targets/selector.js";
import type {
  AttachInput,
  AttachResult,
  DiagnosticError,
  DiagnosticEvent,
  EndpointConfig,
  Instrument,
  LogsInput,
  OpenDialog,
  StatusResult,
  TargetInfo,
} from "../types.js";
import { DiagnosticSession } from "./diagnostic-session.js";
import { Inspector } from "./inspector.js";
import { locateUtilityInspector } from "../utility.js";

function brief(target: TargetInfo): { id: string; title: string; url: string } {
  const { id, title, url } = publicTarget(target);
  return { id, title, url };
}

export class SessionManager {
  readonly config: RuntimeConfig;
  readonly main: DiagnosticSession;
  readonly renderer: DiagnosticSession;
  readonly utility: DiagnosticSession;
  readonly inspector: Inspector;
  private readonly sequence = new EventSequence();
  private mainEndpoint?: EndpointConfig;
  private rendererEndpoint?: EndpointConfig;
  private rendererTargets: TargetInfo[] = [];
  private selectorChangedThisCall = false;
  // What the agent last chose to have installed in the app. Nothing until it asks: the wrappers stay in the app until it
  // restarts, so installing them is the agent's decision, not a side effect of attaching.
  private instrumentChoice: Instrument[] = [];
  private selector: TargetSelector = {};
  // The page the renderer session last inspected. The session forgets its target when the page closes; this does not,
  // so a later automatic selection of a different page is reported instead of happening silently.
  private lastSelected?: TargetInfo;
  private operationQueue: Promise<void> = Promise.resolve();

  constructor(config = readRuntimeConfig()) {
    this.config = config;
    this.main = new DiagnosticSession({
      process: "main",
      sequence: this.sequence,
      requestTimeoutMs: config.requestTimeoutMs,
      maxProtocolMessageBytes: config.maxProtocolMessageBytes,
      maxLogEvents: config.maxLogEvents,
      maxLogBytes: config.maxLogBytes,
    });
    this.renderer = new DiagnosticSession({
      process: "renderer",
      sequence: this.sequence,
      requestTimeoutMs: config.requestTimeoutMs,
      maxProtocolMessageBytes: config.maxProtocolMessageBytes,
      maxLogEvents: config.maxLogEvents,
      maxLogBytes: config.maxLogBytes,
      onDisconnected: () => {
        this.rendererTargets = [];
      },
    });
    this.utility = new DiagnosticSession({
      process: "utility",
      sequence: this.sequence,
      requestTimeoutMs: config.requestTimeoutMs,
      maxProtocolMessageBytes: config.maxProtocolMessageBytes,
      maxLogEvents: config.maxLogEvents,
      maxLogBytes: config.maxLogBytes,
    });
    this.inspector = new Inspector({
      config,
      main: this.main,
      renderer: this.renderer,
      utility: this.utility,
      listEvents: (input) => this.collectEvents(input),
      isBeforeAttach: (event) => this.isBeforeAttach(event),
      lastSeq: () => this.sequence.last,
      logGap: (process, afterSeq) => this.buffersFor(process).some((buffer) => buffer.droppedThroughSeq > (afterSeq ?? 0)),
    });
  }

  async attach(input: AttachInput): Promise<{ ok: true; data: AttachResult } | { ok: false; error: DiagnosticError }> {
    return this.serialize(() => this.attachInternal(input));
  }

  private async attachInternal(
    input: AttachInput,
  ): Promise<{ ok: true; data: AttachResult } | { ok: false; error: DiagnosticError }> {
    const errors: DiagnosticError[] = [];
    const warnings: DiagnosticError[] = [];
    if (input.instrument !== undefined) this.instrumentChoice = [...new Set(input.instrument)];
    if (input.instrument !== undefined && input.instrument.length > 0 && this.config.allowEval === false) {
      warnings.push({
        code: "INSTRUMENT_NOT_ALLOWED",
        message: "求值被禁用（ELECTRON_DEBUG_ALLOW_EVAL=0），不会往应用里装 IPC 或对话框追踪",
        retryable: false,
        hint: "要用 IPC 追踪或对话框监测，需要宿主去掉这个设置并重启 MCP Server。",
      });
    }
    const resolved = this.resolveEndpoints(input, errors);
    if (!resolved.main && !resolved.renderer && input.utility === undefined) {
      return errorResult(
        errors[0] ??
          new DiagnosticException(
            "ENDPOINT_NOT_CONFIGURED",
            "没有提供主进程或 renderer discovery endpoint",
          ).diagnostic,
      );
    }

    this.applyTargetSelection(input);

    if (resolved.main) {
      if (this.main.endpointConfig?.url !== resolved.main.url) {
        await this.main.close("Main endpoint changed");
        await this.closeUtility("Main endpoint changed");
      }
      this.mainEndpoint = resolved.main;
      this.main.setEndpoint(resolved.main);
      try {
        const discovered = await discoverMain(resolved.main.url, {
          timeoutMs: this.config.discoveryTimeoutMs,
        });
        await this.main.connect(resolved.main, discovered.websocketUrl as string);
        if (this.config.allowEval !== false) {
          if (this.instrumentChoice.includes("dialogs")) await this.main.instrumentDialogs();
          if (this.instrumentChoice.includes("ipc")) await this.main.instrumentIpc();
        }
      } catch (error) {
        const diagnostic = toDiagnosticError(error, "MAIN_INSPECTOR_UNAVAILABLE");
        await this.main.close("Main attach failed");
        this.main.setEndpoint(resolved.main);
        this.main.setError(diagnostic);
        errors.push(diagnostic);
      }
    } else if (!resolved.mainError) {
      await this.main.close("Main endpoint not configured");
      await this.closeUtility("Main endpoint not configured");
      this.mainEndpoint = undefined;
      this.main.setEndpoint(undefined);
    }

    if (input.utility !== undefined) {
      await this.attachUtility(input.utility, errors);
    }

    if (resolved.renderer) {
      this.rendererEndpoint = resolved.renderer;
      try {
        await this.refreshRenderer(resolved.renderer, errors, warnings);
      } catch (error) {
        errors.push(toDiagnosticError(error, "RENDERER_CDP_UNAVAILABLE"));
      }
    } else if (!resolved.rendererError) {
      await this.renderer.close("Renderer endpoint not configured");
      this.rendererEndpoint = undefined;
      this.rendererTargets = [];
      this.renderer.setEndpoint(undefined);
    }

    return {
      ok: true,
      data: {
        main: this.main.snapshot(),
        renderer: this.renderer.snapshot(),
        utility: this.utility.snapshot(),
        targets: this.rendererTargets.map(publicTarget),
        selectedTarget: this.renderer.snapshot().selectedTarget,
        instrumented: this.main.instrumented(),
        errors,
        warnings,
      },
    };
  }

  async refreshTargets(
    input: Pick<AttachInput, "rendererUrl" | "targetId" | "url" | "title" | "clearSelection">,
  ): Promise<
    | { ok: true; data: TargetsResult }
    | { ok: false; error: DiagnosticError }
  > {
    return this.serialize(() => this.refreshTargetsInternal(input));
  }

  private async refreshTargetsInternal(
    input: Pick<AttachInput, "rendererUrl" | "targetId" | "url" | "title" | "clearSelection">,
  ): Promise<
    | { ok: true; data: TargetsResult }
    | { ok: false; error: DiagnosticError }
  > {
    const errors: DiagnosticError[] = [];
    const warnings: DiagnosticError[] = [];
    const endpoint = this.resolveRendererEndpoint(input.rendererUrl, errors);
    if (!endpoint) {
      return errorResult(
        errors[0] ??
          new DiagnosticException(
            "ENDPOINT_NOT_CONFIGURED",
            "没有提供 renderer discovery endpoint",
          ).diagnostic,
      );
    }

    this.applyTargetSelection(input);

    this.rendererEndpoint = endpoint;
    try {
      await this.refreshRenderer(endpoint, errors, warnings);
    } catch (error) {
      errors.push(toDiagnosticError(error, "RENDERER_CDP_UNAVAILABLE"));
    }
    return {
      ok: true,
      data: {
        targets: this.rendererTargets.map(publicTarget),
        selectedTarget: this.renderer.snapshot().selectedTarget,
        errors,
        warnings,
      },
    };
  }

  private applyTargetSelection(
    input: Pick<AttachInput, "targetId" | "url" | "title" | "clearSelection">,
  ): void {
    if (input.clearSelection) {
      this.selector = {};
      this.lastSelected = undefined;
      this.renderer.clearTargetSelection();
    }
    this.selectorChangedThisCall = false;
    if (input.targetId !== undefined || input.url !== undefined || input.title !== undefined) {
      this.selectorChangedThisCall = true;
      this.selector = {
        targetId: input.targetId,
        url: input.url,
        title: input.title,
      };
    }
  }

  async close(): Promise<void> {
    await this.serialize(async () => {
      await Promise.all([
        this.main.close("Session manager closed"),
        this.renderer.close("Session manager closed"),
        this.utility.close("Session manager closed"),
      ]);
      this.mainEndpoint = undefined;
      this.rendererEndpoint = undefined;
      this.rendererTargets = [];
      this.selector = {};
      this.lastSelected = undefined;
      this.main.setEndpoint(undefined);
      this.renderer.setEndpoint(undefined);
      this.utility.setEndpoint(undefined);
    });
  }

  private async closeUtility(reason: string): Promise<void> {
    await this.utility.close(reason);
    this.utility.setEndpoint(undefined);
  }

  private async attachUtility(query: string | number, errors: DiagnosticError[]): Promise<void> {
    try {
      const location = await locateUtilityInspector({
        main: this.main,
        allowEval: this.config.allowEval !== false,
        discoveryTimeoutMs: this.config.discoveryTimeoutMs,
        query,
      });
      const endpoint: EndpointConfig = { url: location.endpoint, source: "discovered" };
      const target: TargetInfo = {
        id: String(location.pid),
        type: "utility",
        title: location.name,
        url: location.endpoint,
        webSocketDebuggerUrl: location.websocketUrl,
      };
      this.utility.setEndpoint(endpoint);
      await this.utility.connect(endpoint, location.websocketUrl, target);
    } catch (error) {
      const diagnostic = toDiagnosticError(error, "UTILITY_INSPECTOR_UNAVAILABLE");
      await this.utility.close("Utility attach failed");
      this.utility.setEndpoint(undefined);
      this.utility.setError(diagnostic);
      errors.push(diagnostic);
    }
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.operationQueue;
    const run = previous.catch(() => undefined).then(operation);
    this.operationQueue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  status(): StatusResult {
    const dialogs: OpenDialog[] = [
      ...this.main.dialogs.list,
      ...this.renderer.dialogs.list,
      ...this.utility.dialogs.list,
    ];
    return {
      main: this.main.snapshot(),
      renderer: this.renderer.snapshot(),
      utility: this.utility.snapshot(),
      targets: this.rendererTargets.map(publicTarget),
      selectedTarget: this.renderer.snapshot().selectedTarget,
      ...(dialogs.length > 0 ? { dialogs } : {}),
      lastSeq: this.sequence.last,
    };
  }

  logs(input: LogsInput): {
    events: DiagnosticEvent[];
    cleared: boolean;
    lastSeq: number;
    droppedThroughSeq: number;
    gap: boolean;
  } {
    const clear = input.clear === true;
    const buffers = this.buffersFor(input.process);
    const events = this.collectEvents(input).slice(-(input.limit ?? 100));
    const lastSeq = this.sequence.last;
    // Events at or below this seq may have been evicted from a full buffer; `gap` says whether that
    // can affect what the caller asked for (everything after afterSeq, or the whole history without it).
    const droppedThroughSeq = Math.max(0, ...buffers.map((buffer) => buffer.droppedThroughSeq));
    const gap = buffers.some((buffer) => buffer.droppedThroughSeq > (this.afterSeqFor(buffer, input) ?? 0));

    if (clear) {
      // Clear must not delete what the caller did not get back: a filter narrows what is returned, and so does the
      // limit, which is 100 when none is given.
      const everything = events.length === buffers.reduce((sum, buffer) => sum + buffer.size, 0);
      const returned = new Set(events.flatMap((event) => (event.seq === undefined ? [] : [event.seq])));
      for (const buffer of buffers) {
        if (everything) buffer.clear();
        else buffer.remove(returned);
      }
    }
    return { events, cleared: clear, lastSeq, droppedThroughSeq, gap };
  }

  private buffersFor(scope: LogsInput["process"] = "all"): EventBuffer[] {
    return [
      ...(scope === "all" || scope === "main" ? [this.main.events] : []),
      ...(scope === "all" || scope === "renderer" ? [this.renderer.events] : []),
      ...(scope === "all" || scope === "utility" ? [this.utility.events] : []),
    ];
  }

  // With sinceAttach each channel starts after its own latest connection, so replayed history is left out.
  private afterSeqFor(buffer: EventBuffer, input: LogsInput): number | undefined {
    return input.sinceAttach === true ? Math.max(input.afterSeq ?? 0, buffer.lastConnectedSeq) : input.afterSeq;
  }

  private isBeforeAttach(event: DiagnosticEvent): boolean {
    const buffer = this.buffersFor(event.process)[0];
    return buffer !== undefined && (event.seq ?? 0) < buffer.lastConnectedSeq;
  }

  private collectEvents(input: LogsInput): DiagnosticEvent[] {
    return this.buffersFor(input.process)
      .flatMap((buffer) => buffer.list({ ...input, afterSeq: this.afterSeqFor(buffer, input) }))
      .sort((left, right) => (left.seq ?? 0) - (right.seq ?? 0));
  }

  private resolveEndpoints(input: AttachInput, errors: DiagnosticError[]): {
    main?: EndpointConfig;
    renderer?: EndpointConfig;
    mainError: boolean;
    rendererError: boolean;
  } {
    let main: EndpointConfig | undefined;
    let renderer: EndpointConfig | undefined;
    let mainError = false;
    let rendererError = false;
    try {
      main = resolveEndpoint(
        input.mainUrl,
        this.config.mainUrl,
        this.mainEndpoint,
        "mainUrl",
      );
    } catch (error) {
      mainError = true;
      errors.push(toDiagnosticError(error, "ENDPOINT_CONFIG_INVALID"));
    }
    try {
      renderer = resolveEndpoint(
        input.rendererUrl,
        this.config.rendererUrl,
        this.rendererEndpoint,
        "rendererUrl",
      );
    } catch (error) {
      rendererError = true;
      errors.push(toDiagnosticError(error, "ENDPOINT_CONFIG_INVALID"));
    }
    return { main, renderer, mainError, rendererError };
  }

  private resolveRendererEndpoint(
    inputValue: string | undefined,
    errors: DiagnosticError[],
  ): EndpointConfig | undefined {
    try {
      return resolveEndpoint(
        inputValue,
        this.config.rendererUrl,
        this.rendererEndpoint,
        "rendererUrl",
      );
    } catch (error) {
      errors.push(toDiagnosticError(error, "ENDPOINT_CONFIG_INVALID"));
      return undefined;
    }
  }

  private async refreshRenderer(
    endpoint: EndpointConfig,
    errors: DiagnosticError[],
    warnings: DiagnosticError[],
  ): Promise<void> {
    const previousEndpoint = this.renderer.endpointConfig?.url;
    if (previousEndpoint !== undefined && previousEndpoint !== endpoint.url) {
      await this.renderer.close("Renderer endpoint changed");
      // A new endpoint is a restarted or different app: its pages are new, not replacements of the old ones.
      this.lastSelected = undefined;
    }

    this.renderer.setEndpoint(endpoint);
    this.rendererTargets = [];

    let discovered: Awaited<ReturnType<typeof discoverRenderer>>;
    try {
      discovered = await discoverRenderer(endpoint.url, {
        timeoutMs: this.config.discoveryTimeoutMs,
      });
    } catch (error) {
      const diagnostic = toDiagnosticError(error, "RENDERER_CDP_UNAVAILABLE");
      await this.renderer.close("Renderer discovery failed");
      this.renderer.setEndpoint(endpoint);
      this.renderer.setError(diagnostic);
      errors.push(diagnostic);
      return;
    }
    this.rendererTargets = pageTargets(discovered.targets);
    if (discovered.userAgent !== undefined && !discovered.userAgent.includes("Electron/")) {
      warnings.push({
        code: "RENDERER_NOT_ELECTRON",
        message: "renderer endpoint 的 User-Agent 里没有 Electron",
        retryable: false,
        hint: "这个端口可能是浏览器（例如同样使用 9222 端口的 Chrome）而不是要验证的应用；核对端口。" +
          "应用自己改写了 User-Agent 时可忽略。",
        details: { userAgent: discovered.userAgent.slice(0, 300) },
      });
    }

    let target: TargetInfo;
    try {
      const previous = this.renderer.snapshot().selectedTarget ?? this.lastSelected;
      const hasExplicitSelector = Object.values(this.selector).some(Boolean);
      const previousStillExists =
        previous !== undefined && this.rendererTargets.some((candidate) => candidate.id === previous.id);
      const selector = hasExplicitSelector
        ? this.selector
        : previousStillExists
          ? { targetId: previous.id }
          : {};
      let selected: TargetInfo | undefined;
      try {
        selected = selectTarget(this.rendererTargets, selector);
      } catch (selectionError) {
        // A selector remembered from an earlier call (a title that has since changed) must not take down a working
        // connection: keep the page that is already selected and say why the selector no longer matches.
        const kept = hasExplicitSelector && !this.selectorChangedThisCall && previousStillExists
          ? this.rendererTargets.find((candidate) => candidate.id === previous?.id) : undefined;
        if (!kept) throw selectionError;
        selected = kept;
        warnings.push({
          code: "TARGET_SELECTOR_STALE",
          message: "之前传入的 title、url 或 targetId 已不再匹配任何页面，仍沿用当前已选中的页面",
          retryable: false,
          hint: "页面可能改了标题或跳转了地址。确认它仍是要验证的窗口；要换页面就重新传 title、url 或 targetId，或传 clearSelection。",
          details: { selected: brief(kept) },
        });
      }
      if (!selected) {
        throw new DiagnosticException("TARGET_NOT_FOUND", "没有选中的 target", { retryable: true });
      }
      target = selected;
      if (!hasExplicitSelector && previous !== undefined && previous.id !== target.id) {
        warnings.push({
          code: "TARGET_CHANGED",
          message: "之前检查的页面已不存在，已自动改选另一个页面",
          retryable: false,
          hint: "确认新页面就是要验证的窗口（对照 title 和 url）；之后的日志、截图和求值都来自新页面。" +
            "有意切换时传 clearSelection 可去掉这条提示。",
          details: { previous: brief(previous), selected: brief(target) },
        });
      }
    } catch (error) {
      const diagnostic = toDiagnosticError(error, "TARGET_NOT_FOUND");
      await this.renderer.close("Renderer target selection failed");
      this.renderer.setEndpoint(endpoint);
      this.renderer.setError(diagnostic);
      errors.push(diagnostic);
      return;
    }

    if (!target.webSocketDebuggerUrl) {
      const diagnostic = {
        code: "TARGET_NOT_FOUND",
        message: "选中的 target 没有可连接的 WebSocket 地址",
        retryable: true,
      };
      await this.renderer.close("Renderer target has no WebSocket");
      this.renderer.setEndpoint(endpoint);
      this.renderer.setError(diagnostic);
      errors.push(diagnostic);
      return;
    }

    try {
      await this.renderer.connect(endpoint, target.webSocketDebuggerUrl, target);
      this.lastSelected = target;
    } catch (error) {
      const diagnostic = toDiagnosticError(error, "RENDERER_CDP_UNAVAILABLE");
      this.renderer.setError(diagnostic);
      errors.push(diagnostic);
    }
  }
}

export interface TargetsResult {
  targets: TargetInfo[];
  selectedTarget?: TargetInfo;
  errors: DiagnosticError[];
  warnings: DiagnosticError[];
}
