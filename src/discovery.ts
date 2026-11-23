import { discoveryUrl, validateDebuggerWebSocketUrl } from "./config.js";
import { DiagnosticException, toDiagnosticError, transportCode } from "./errors.js";
import type { TargetInfo } from "./types.js";

export interface DiscoveryResult {
  endpoint: string;
  websocketUrl?: string;
  targets: TargetInfo[];
  userAgent?: string;
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
    await response.body?.cancel().catch(() => undefined);
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
      await response.body?.cancel().catch(() => undefined);
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
    // Only a completed but malformed document is a non-retryable JSON error.
    // Timeout and interrupted streams retain their transport error classification.
    if (!(cause instanceof SyntaxError)) {
      throw cause;
    }
    throw new DiagnosticException("PROTOCOL_ERROR", "discovery 返回的内容不是有效 JSON", { cause });
  }

  if (!Array.isArray(body)) {
    throw new DiagnosticException("PROTOCOL_ERROR", "discovery 返回的 target 列表格式无效");
  }
  return body.map(toTarget);
}

type Channel = "main" | "renderer";

const notDebugPortHint =
  "这个端口有程序在响应，但不是调试端口（例如开发服务器或别的服务），核对启动参数里的端口号。";

// The failure message stays the underlying error; the hint only says where to look next.
function failureHint(channel: Channel, error: unknown): string | undefined {
  const diagnostic = error instanceof DiagnosticException ? error.diagnostic : undefined;
  if (diagnostic?.hint !== undefined) return diagnostic.hint;
  if (diagnostic?.code === "NON_LOOPBACK_ENDPOINT" || diagnostic?.code === "OUTPUT_TOO_LARGE") return undefined;
  if (diagnostic?.code === "PROTOCOL_ERROR") return notDebugPortHint;
  const code = transportCode(error);
  if (code === "ECONNREFUSED") {
    return channel === "main"
      ? "端口上没有进程在监听。确认应用已用 --inspect=<端口> 启动且仍在运行（参数只在启动时生效，已运行的应用要重启）；" +
        "electron-vite、Forge 等脚手架要按各自的方式转发参数；renderer 能连上而主进程连不上时，" +
        "可能是应用关闭了 EnableNodeCliInspectArguments fuse。"
      : "端口上没有进程在监听。确认应用已用 --remote-debugging-port=<端口> 启动且仍在运行（参数只在启动时生效，已运行的应用要重启）；" +
        "环境里设有 ELECTRON_RUN_AS_NODE=1 时 Electron 按 Node 运行，不会打开这个端口。";
  }
  if (code === "ETIMEDOUT") {
    return channel === "main"
      ? "端口在但没有及时响应：可能被别的程序占用，或主进程停在 --inspect-brk 断点、被同步原生对话框阻塞。"
      : "端口在但没有及时响应：可能被别的程序占用，或应用正卡在启动中。";
  }
  if (code === "ECONNRESET") return notDebugPortHint;
  return undefined;
}

function rethrow(channel: Channel, error: unknown, fallbackCode: string): never {
  const diagnostic = toDiagnosticError(error, fallbackCode);
  const hint = failureHint(channel, error);
  throw new DiagnosticException(diagnostic.code, diagnostic.message, {
    retryable: diagnostic.retryable,
    hint,
    details: diagnostic.details,
    cause: error,
  });
}

export async function discoverMain(
  endpoint: string,
  options: DiscoveryOptions,
): Promise<DiscoveryResult> {
  try {
    const targets = await fetchDiscovery(endpoint, options.timeoutMs);
    // A renderer CDP port also answers /json/list with WebSocket URLs; connecting to one of its pages as the main
    // process would silently run "main" evaluations inside a window.
    if (!targets.some((candidate) => candidate.type === "node") &&
      targets.some((candidate) => candidate.type === "page")) {
      throw new DiagnosticException("MAIN_INSPECTOR_UNAVAILABLE", "主进程 endpoint 返回的是渲染进程的 page target", {
        hint: "这是 --remote-debugging-port 打开的渲染进程端口；mainUrl 应传 --inspect 的端口，两个端口可能传反了。",
      });
    }
    const target = targets.find((candidate) => candidate.webSocketDebuggerUrl);
    if (!target?.webSocketDebuggerUrl) {
      throw new DiagnosticException("MAIN_INSPECTOR_UNAVAILABLE", "主进程 discovery 未返回可连接 target", {
        retryable: true,
        hint: "端口上的 Inspector 已经有别的调试客户端连着，或主进程还没准备好；关闭其他调试器后重试。",
      });
    }
    return { endpoint, websocketUrl: target.webSocketDebuggerUrl, targets };
  } catch (error) {
    rethrow("main", error, "MAIN_INSPECTOR_UNAVAILABLE");
  }
}

// The renderer port of an Electron app reports `Electron/<version>` in its user agent. A browser on the same port
// (9222 is a common default for both) would otherwise be attached to and inspected as if it were the app.
async function fetchUserAgent(endpoint: string, timeoutMs: number): Promise<string | undefined> {
  try {
    const url = new URL(discoveryUrl(endpoint));
    url.pathname = url.pathname.replace(/\/json\/list$/u, "/json/version");
    const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), redirect: "error" });
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      return undefined;
    }
    const text = await response.text();
    if (text.length > 65_536) return undefined;
    const body = JSON.parse(text) as Record<string, unknown>;
    return typeof body["User-Agent"] === "string" ? body["User-Agent"] : undefined;
  } catch {
    return undefined;
  }
}

export async function discoverRenderer(
  endpoint: string,
  options: DiscoveryOptions,
): Promise<DiscoveryResult> {
  try {
    const [targets, userAgent] = await Promise.all([
      fetchDiscovery(endpoint, options.timeoutMs),
      fetchUserAgent(endpoint, options.timeoutMs),
    ]);
    if (targets.length > 0 && targets.every((candidate) => candidate.type === "node")) {
      throw new DiagnosticException("RENDERER_CDP_UNAVAILABLE", "renderer endpoint 返回的是主进程 Inspector 的 node target", {
        hint: "这是 --inspect 打开的主进程端口；rendererUrl 应传 --remote-debugging-port 的端口，两个端口可能传反了。",
      });
    }
    return { endpoint, targets, userAgent };
  } catch (error) {
    rethrow("renderer", error, "RENDERER_CDP_UNAVAILABLE");
  }
}

/** Target types that can be selected and inspected: windows and views, and `<webview>` guests on request. */
export const selectableTargetTypes = new Set(["page", "webview"]);

export function pageTargets(targets: TargetInfo[]): TargetInfo[] {
  return targets.filter((target) => selectableTargetTypes.has(target.type));
}
