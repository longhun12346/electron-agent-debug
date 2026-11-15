import {
  readRuntimeConfig,
  resolveEndpoint,
  type RuntimeConfig,
} from "../config.js";
import { discoverMain, discoverRenderer, pageTargets } from "../discovery.js";
import { DiagnosticException, errorResult, toDiagnosticError } from "../errors.js";
import { selectTarget, type TargetSelector } from "../targets/selector.js";
import type {
  AttachInput,
  AttachResult,
  DiagnosticError,
  EndpointConfig,
  LogsInput,
  StatusResult,
  TargetInfo,
} from "../types.js";
import { DiagnosticSession } from "./diagnostic-session.js";

export class SessionManager {
  readonly config: RuntimeConfig;
  readonly main: DiagnosticSession;
  readonly renderer: DiagnosticSession;
  private mainEndpoint?: EndpointConfig;
  private rendererEndpoint?: EndpointConfig;
  private rendererTargets: TargetInfo[] = [];
  private selector: TargetSelector = {};
  private operationQueue: Promise<void> = Promise.resolve();

  constructor(config = readRuntimeConfig()) {
    this.config = config;
    this.main = new DiagnosticSession({
      process: "main",
      requestTimeoutMs: config.requestTimeoutMs,
      maxProtocolMessageBytes: config.maxProtocolMessageBytes,
      maxLogEvents: config.maxLogEvents,
      maxLogBytes: config.maxLogBytes,
    });
    this.renderer = new DiagnosticSession({
      process: "renderer",
      requestTimeoutMs: config.requestTimeoutMs,
      maxProtocolMessageBytes: config.maxProtocolMessageBytes,
      maxLogEvents: config.maxLogEvents,
      maxLogBytes: config.maxLogBytes,
      onDisconnected: () => {
        this.rendererTargets = [];
      },
    });
  }

  async attach(input: AttachInput): Promise<{ ok: true; data: AttachResult } | { ok: false; error: DiagnosticError }> {
    return this.serialize(() => this.attachInternal(input));
  }

  private async attachInternal(
    input: AttachInput,
  ): Promise<{ ok: true; data: AttachResult } | { ok: false; error: DiagnosticError }> {
    const errors: DiagnosticError[] = [];
    const resolved = this.resolveEndpoints(input, errors);
    if (!resolved.main && !resolved.renderer) {
      return errorResult(
        errors[0] ??
          new DiagnosticException(
            "ENDPOINT_NOT_CONFIGURED",
            "没有提供主进程或 renderer discovery endpoint",
          ).diagnostic,
      );
    }

    if (input.clearSelection) {
      this.selector = {};
      this.renderer.clearTargetSelection();
    }
    if (input.targetId !== undefined || input.url !== undefined || input.title !== undefined) {
      this.selector = {
        targetId: input.targetId,
        url: input.url,
        title: input.title,
      };
    }

    if (resolved.main) {
      if (this.main.endpointConfig?.url !== resolved.main.url) {
        await this.main.close("Main endpoint changed");
      }
      this.mainEndpoint = resolved.main;
      this.main.setEndpoint(resolved.main);
      try {
        const discovered = await discoverMain(resolved.main.url, {
          timeoutMs: this.config.discoveryTimeoutMs,
        });
        await this.main.connect(resolved.main, discovered.websocketUrl as string);
      } catch (error) {
        const diagnostic = toDiagnosticError(error, "MAIN_INSPECTOR_UNAVAILABLE");
        await this.main.close("Main attach failed");
        this.main.setEndpoint(resolved.main);
        this.main.setError(diagnostic);
        errors.push(diagnostic);
      }
    } else if (!resolved.mainError) {
      await this.main.close("Main endpoint not configured");
      this.mainEndpoint = undefined;
      this.main.setEndpoint(undefined);
    }

    if (resolved.renderer) {
      this.rendererEndpoint = resolved.renderer;
      try {
        await this.refreshRenderer(resolved.renderer, errors);
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
        targets: this.rendererTargets,
        selectedTarget: this.renderer.snapshot().selectedTarget,
        errors,
      },
    };
  }

  async refreshTargets(
    input: Pick<AttachInput, "rendererUrl" | "targetId" | "url" | "title" | "clearSelection">,
  ): Promise<
    | { ok: true; data: { targets: TargetInfo[]; selectedTarget?: TargetInfo; errors: DiagnosticError[] } }
    | { ok: false; error: DiagnosticError }
  > {
    return this.serialize(() => this.refreshTargetsInternal(input));
  }

  private async refreshTargetsInternal(
    input: Pick<AttachInput, "rendererUrl" | "targetId" | "url" | "title" | "clearSelection">,
  ): Promise<
    | { ok: true; data: { targets: TargetInfo[]; selectedTarget?: TargetInfo; errors: DiagnosticError[] } }
    | { ok: false; error: DiagnosticError }
  > {
    const errors: DiagnosticError[] = [];
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

    if (input.clearSelection) {
      this.selector = {};
      this.renderer.clearTargetSelection();
    }
    if (input.targetId !== undefined || input.url !== undefined || input.title !== undefined) {
      this.selector = {
        targetId: input.targetId,
        url: input.url,
        title: input.title,
      };
    }

    this.rendererEndpoint = endpoint;
    try {
      await this.refreshRenderer(endpoint, errors);
    } catch (error) {
      errors.push(toDiagnosticError(error, "RENDERER_CDP_UNAVAILABLE"));
    }
    return {
      ok: true,
      data: {
        targets: this.rendererTargets,
        selectedTarget: this.renderer.snapshot().selectedTarget,
        errors,
      },
    };
  }

  async close(): Promise<void> {
    await this.serialize(async () => {
      await Promise.all([
        this.main.close("Session manager closed"),
        this.renderer.close("Session manager closed"),
      ]);
      this.mainEndpoint = undefined;
      this.rendererEndpoint = undefined;
      this.rendererTargets = [];
      this.selector = {};
      this.main.setEndpoint(undefined);
      this.renderer.setEndpoint(undefined);
    });
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
    return {
      main: this.main.snapshot(),
      renderer: this.renderer.snapshot(),
      targets: this.rendererTargets,
      selectedTarget: this.renderer.snapshot().selectedTarget,
    };
  }

  logs(input: LogsInput): {
    events: ReturnType<DiagnosticSession["events"]["list"]>;
    cleared: boolean;
  } {
    const clear = input.clear === true;
    const events = [
      ...(input.process === "renderer" ? [] : this.main.events.list(input)),
      ...(input.process === "main" ? [] : this.renderer.events.list(input)),
    ]
      .sort((left, right) => left.observedAt.localeCompare(right.observedAt))
      .slice(-(input.limit ?? 100));

    if (clear) {
      if (!input.process || input.process === "all" || input.process === "main") {
        this.main.events.clear();
      }
      if (!input.process || input.process === "all" || input.process === "renderer") {
        this.renderer.events.clear();
      }
    }
    return { events, cleared: clear };
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
  ): Promise<void> {
    const previousEndpoint = this.renderer.endpointConfig?.url;
    if (previousEndpoint !== undefined && previousEndpoint !== endpoint.url) {
      await this.renderer.close("Renderer endpoint changed");
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

    let target: TargetInfo;
    try {
      const previous = this.renderer.snapshot().selectedTarget;
      const hasExplicitSelector = Object.values(this.selector).some(Boolean);
      const previousStillExists =
        previous !== undefined && this.rendererTargets.some((candidate) => candidate.id === previous.id);
      const selector = hasExplicitSelector
        ? this.selector
        : previousStillExists
          ? { targetId: previous.id }
          : {};
      const selected = selectTarget(this.rendererTargets, selector);
      if (!selected) {
        throw new DiagnosticException("TARGET_NOT_FOUND", "没有选中的 target", { retryable: true });
      }
      target = selected;
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
    } catch (error) {
      const diagnostic = toDiagnosticError(error, "RENDERER_CDP_UNAVAILABLE");
      this.renderer.setError(diagnostic);
      errors.push(diagnostic);
    }
  }
}
