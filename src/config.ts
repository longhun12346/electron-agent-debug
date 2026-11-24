import { z } from "zod";
import { DiagnosticException } from "./errors.js";
import type { AttachInput, EndpointConfig, EndpointSource } from "./types.js";

const attachInputSchema = z.object({
  mainUrl: z.string().optional(),
  rendererUrl: z.string().optional(),
  utility: z.union([z.string().min(1), z.number().int().positive()]).optional(),
  targetId: z.string().optional(),
  url: z.string().optional(),
  title: z.string().optional(),
  clearSelection: z.boolean().optional(),
  instrument: z.array(z.enum(["ipc", "dialogs"])).max(2).optional(),
});

export const environmentNames = {
  mainUrl: "ELECTRON_DEBUG_MAIN_URL",
  rendererUrl: "ELECTRON_DEBUG_CDP_URL",
} as const;

export interface RuntimeConfig {
  mainUrl?: string;
  rendererUrl?: string;
  requestTimeoutMs: number;
  discoveryTimeoutMs: number;
  maxLogEvents: number;
  maxLogBytes: number;
  maxProtocolMessageBytes: number;
  allowEval?: boolean;
  outputDir?: string;
}

function boundedInteger(
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  if (value === undefined || value.trim() === "") {
    return fallback;
  }

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new DiagnosticException(
      "ENDPOINT_CONFIG_INVALID",
      "诊断配置中的数值超出允许范围",
      { details: { minimum, maximum } },
    );
  }
  return parsed;
}

export function readRuntimeConfig(env: NodeJS.ProcessEnv = process.env): RuntimeConfig {
  return {
    mainUrl: env[environmentNames.mainUrl],
    rendererUrl: env[environmentNames.rendererUrl],
    requestTimeoutMs: boundedInteger(env.ELECTRON_DEBUG_REQUEST_TIMEOUT_MS, 3_000, 100, 30_000),
    discoveryTimeoutMs: boundedInteger(
      env.ELECTRON_DEBUG_DISCOVERY_TIMEOUT_MS,
      3_000,
      100,
      30_000,
    ),
    maxLogEvents: boundedInteger(env.ELECTRON_DEBUG_MAX_LOG_EVENTS, 500, 10, 10_000),
    maxLogBytes: boundedInteger(env.ELECTRON_DEBUG_MAX_LOG_BYTES, 1_048_576, 4_096, 16_777_216),
    maxProtocolMessageBytes: boundedInteger(
      env.ELECTRON_DEBUG_MAX_PROTOCOL_MESSAGE_BYTES,
      268_435_456,
      4_096,
      268_435_456,
    ),
    allowEval: !["0", "false", "off", "no", "disabled"].includes((env.ELECTRON_DEBUG_ALLOW_EVAL ?? "").trim().toLowerCase()),
    outputDir: env.ELECTRON_DEBUG_OUTPUT_DIR?.trim() || undefined,
  };
}

export function parseAttachInput(value: unknown): AttachInput {
  return attachInputSchema.parse(value ?? {});
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1";
}

export function validateDiscoveryUrl(raw: string, fieldName: string): string {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch (cause) {
    throw new DiagnosticException("INVALID_ENDPOINT", `${fieldName} 不是有效的 URL`, { cause });
  }

  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new DiagnosticException("ENDPOINT_CONFIG_INVALID", `${fieldName} 必须使用 HTTP(S)`, {
      details: { fieldName },
    });
  }
  if (!isLoopbackHostname(parsed.hostname)) {
    throw new DiagnosticException("NON_LOOPBACK_ENDPOINT", `${fieldName} 必须指向回环地址`, {
      details: { fieldName },
    });
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new DiagnosticException(
      "ENDPOINT_CONFIG_INVALID",
      `${fieldName} 不得包含凭据、查询参数或 hash`,
      { details: { fieldName } },
    );
  }

  return parsed.toString().replace(/\/$/, "");
}

export function validateDebuggerWebSocketUrl(raw: string): string {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch (cause) {
    throw new DiagnosticException("PROTOCOL_ERROR", "discovery 返回了无效的 WebSocket 地址", { cause });
  }
  if (!["ws:", "wss:"].includes(parsed.protocol) || !isLoopbackHostname(parsed.hostname)) {
    throw new DiagnosticException(
      "NON_LOOPBACK_ENDPOINT",
      "discovery 返回的 WebSocket 地址不是允许的回环地址",
    );
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new DiagnosticException(
      "PROTOCOL_ERROR",
      "discovery 返回的 WebSocket 地址包含凭据、查询参数或 hash",
    );
  }
  return parsed.toString();
}

export function resolveEndpoint(
  inputValue: string | undefined,
  environmentValue: string | undefined,
  sessionValue: EndpointConfig | undefined,
  fieldName: string,
): EndpointConfig | undefined {
  if (inputValue !== undefined) {
    return { url: validateDiscoveryUrl(inputValue, fieldName), source: "attach_input" };
  }
  if (environmentValue !== undefined && environmentValue.trim() !== "") {
    return { url: validateDiscoveryUrl(environmentValue, fieldName), source: "environment" };
  }
  if (sessionValue !== undefined) {
    return { ...sessionValue, source: "session" };
  }
  return undefined;
}

export function endpointSourceLabel(source: EndpointSource | undefined): EndpointSource | undefined {
  return source;
}

export function discoveryUrl(endpoint: string): string {
  const parsed = new URL(endpoint);
  const pathname = parsed.pathname.replace(/\/+$/, "");
  parsed.pathname = pathname.endsWith("/json/list") ? pathname : `${pathname}/json/list`;
  return parsed.toString();
}
