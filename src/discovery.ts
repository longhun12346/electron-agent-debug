import { discoveryUrl, validateDebuggerWebSocketUrl } from "./config.js";
import { DiagnosticException, toDiagnosticError } from "./errors.js";
import type { TargetInfo } from "./types.js";

export interface DiscoveryResult {
  endpoint: string;
  websocketUrl?: string;
  targets: TargetInfo[];
}

export interface DiscoveryOptions {
  timeoutMs: number;
}

const MAX_DISCOVERY_RESPONSE_BYTES = 1_048_576;

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function toTarget(value: unknown): TargetInfo {
  const record = asRecord(value);
  const id = typeof record.id === "string" ? record.id : "";
  if (id === "") {
    throw new DiagnosticException("PROTOCOL_ERROR", "discovery 返回的 target 缺少 id");
  }

  const websocketValue = record.webSocketDebuggerUrl;
  const websocketUrl =
    typeof websocketValue === "string" ? validateDebuggerWebSocketUrl(websocketValue) : undefined;

  return {
    id,
    type: typeof record.type === "string" ? record.type : "unknown",
    title: typeof record.title === "string" ? record.title : "",
    url: typeof record.url === "string" ? record.url : "",
    webSocketDebuggerUrl: websocketUrl,
    faviconUrl: typeof record.faviconUrl === "string" ? record.faviconUrl : undefined,
  };
}

async function fetchDiscovery(endpoint: string, timeoutMs: number): Promise<TargetInfo[]> {
  const response = await fetch(discoveryUrl(endpoint), {
    signal: AbortSignal.timeout(timeoutMs),
    redirect: "error",
  });
  if (!response.ok) {
    throw new DiagnosticException(
      "PROTOCOL_ERROR",
      `discovery 请求失败（HTTP ${response.status}）`,
      { retryable: response.status >= 500 },
    );
  }

  let body: unknown;
  try {
    const contentLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(contentLength) && contentLength > MAX_DISCOVERY_RESPONSE_BYTES) {
      throw new DiagnosticException("OUTPUT_TOO_LARGE", "discovery 响应超过大小上限");
    }
    if (!response.body) {
      throw new DiagnosticException("PROTOCOL_ERROR", "discovery 响应没有可读取的内容");
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let totalBytes = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        totalBytes += value.byteLength;
        if (totalBytes > MAX_DISCOVERY_RESPONSE_BYTES) {
          await reader.cancel().catch(() => undefined);
          throw new DiagnosticException("OUTPUT_TOO_LARGE", "discovery 响应超过大小上限");
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
    const text = Buffer.concat(chunks).toString("utf8");
    body = JSON.parse(text) as unknown;
  } catch (cause) {
    if (cause instanceof DiagnosticException) {
      throw cause;
    }
    throw new DiagnosticException("PROTOCOL_ERROR", "discovery 返回的内容不是有效 JSON", { cause });
  }

  if (!Array.isArray(body)) {
    throw new DiagnosticException("PROTOCOL_ERROR", "discovery 返回的 target 列表格式无效");
  }
  return body.map(toTarget);
}

export async function discoverMain(
  endpoint: string,
  options: DiscoveryOptions,
): Promise<DiscoveryResult> {
  try {
    const targets = await fetchDiscovery(endpoint, options.timeoutMs);
    const target = targets.find((candidate) => candidate.webSocketDebuggerUrl);
    if (!target?.webSocketDebuggerUrl) {
      throw new DiagnosticException("MAIN_INSPECTOR_UNAVAILABLE", "主进程 discovery 未返回可连接 target", {
        retryable: true,
      });
    }
    return { endpoint, websocketUrl: target.webSocketDebuggerUrl, targets };
  } catch (error) {
    const diagnostic = toDiagnosticError(error, "MAIN_INSPECTOR_UNAVAILABLE");
    throw new DiagnosticException(diagnostic.code, diagnostic.message, {
      retryable: diagnostic.retryable,
      details: diagnostic.details,
      cause: error,
    });
  }
}

export async function discoverRenderer(
  endpoint: string,
  options: DiscoveryOptions,
): Promise<DiscoveryResult> {
  try {
    const targets = await fetchDiscovery(endpoint, options.timeoutMs);
    return { endpoint, targets };
  } catch (error) {
    const diagnostic = toDiagnosticError(error, "RENDERER_CDP_UNAVAILABLE");
    throw new DiagnosticException(diagnostic.code, diagnostic.message, {
      retryable: diagnostic.retryable,
      details: diagnostic.details,
      cause: error,
    });
  }
}

export function pageTargets(targets: TargetInfo[]): TargetInfo[] {
  return targets.filter((target) => target.type === "page");
}
