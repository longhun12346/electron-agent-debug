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

  constructor(config = readRuntimeConfig()) {
    this.config = config;
    this.main = new DiagnosticSession({
      process: "main",
      requestTimeoutMs: config.requestTimeoutMs,
      maxLogEvents: config.maxLogEvents,
      maxLogBytes: config.maxLogBytes,
    });
    this.renderer = new DiagnosticSession({
      process: "renderer",
      requestTimeoutMs: config.requestTimeoutMs,
      maxLogEvents: config.maxLogEvents,
      maxLogBytes: config.maxLogBytes,
    });
  }

  async attach(input: AttachInput): Promise<{ ok: true; data: AttachResult } | { ok: false; error: DiagnosticError }> {
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

    if (input.targetId !== undefined || input.url !== undefined || input.title !== undefined) {
      this.selector = {
        targetId: input.targetId,
        url: input.url,
        title: input.title,
      };
    }

    if (resolved.main) {
      this.mainEndpoint = resolved.main;
      this.main.setEndpoint(resolved.main);
      try {
        const discovered = await discoverMain(resolved.main.url, {
          timeoutMs: this.config.discoveryTimeoutMs,
        });
        await this.main.connect(resolved.main, discovered.websocketUrl as string);
      } catch (error) {
        errors.push(toDiagnosticError(error, "MAIN_INSPECTOR_UNAVAILABLE"));
      }
    } else {
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
    } else {
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
    input: Pick<AttachInput, "rendererUrl" | "targetId" | "url" | "title">,
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
      ...this.main.events.list({ ...input, process: "main" }),
      ...this.renderer.events.list({ ...input, process: "renderer" }),
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
  } {
    let main: EndpointConfig | undefined;
    let renderer: EndpointConfig | undefined;
    try {
      main = resolveEndpoint(
        input.mainUrl,
        this.config.mainUrl,
        this.mainEndpoint,
        "mainUrl",
      );
    } catch (error) {
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
      errors.push(toDiagnosticError(error, "ENDPOINT_CONFIG_INVALID"));
    }
    return { main, renderer };
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
    const previousTarget = this.renderer.snapshot().selectedTarget;
    if (previousEndpoint !== undefined && previousEndpoint !== endpoint.url) {
      await this.renderer.close("Renderer endpoint changed");
    }

    const discovered = await discoverRenderer(endpoint.url, {
      timeoutMs: this.config.discoveryTimeoutMs,
    });
    this.rendererTargets = pageTargets(discovered.targets);
    this.renderer.setDiscoveryOnline(endpoint);

    let target: TargetInfo;
    try {
      const previous = this.renderer.snapshot().selectedTarget;
      const selector = Object.values(this.selector).some(Boolean)
        ? this.selector
        : previous
          ? { targetId: previous.id }
          : {};
      const selected = selectTarget(this.rendererTargets, selector);
      if (!selected) {
        throw new DiagnosticException("TARGET_NOT_FOUND", "没有选中的 target", { retryable: true });
      }
      target = selected;
    } catch (error) {
      if (previousTarget) {
        await this.renderer.close("Renderer target selection changed");
        this.renderer.setDiscoveryOnline(endpoint);
      }
      errors.push(toDiagnosticError(error, "TARGET_NOT_FOUND"));
      return;
    }

    if (!target.webSocketDebuggerUrl) {
      if (previousTarget) {
        await this.renderer.close("Renderer target has no WebSocket");
        this.renderer.setDiscoveryOnline(endpoint);
      }
      errors.push({
        code: "TARGET_NOT_FOUND",
        message: "选中的 target 没有可连接的 WebSocket 地址",
        retryable: true,
      });
      return;
    }

    try {
      await this.renderer.connect(endpoint, target.webSocketDebuggerUrl, target);
    } catch (error) {
      errors.push(toDiagnosticError(error, "RENDERER_CDP_UNAVAILABLE"));
    }
  }
}
