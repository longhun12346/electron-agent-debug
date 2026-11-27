import { DiagnosticException } from "../errors.js";
import type { TargetInfo } from "../types.js";

export interface TargetSelector {
  targetId?: string;
  url?: string;
  title?: string;
}

// Target types that can be selected and inspected. `<webview>` guests are listed next to the windows but are never the
// window under test on their own: they can be selected explicitly, and are left out of the automatic choice.
export const selectableTargetTypes = new Set(["page", "webview"]);

export function selectTarget(targets: TargetInfo[], selector: TargetSelector): TargetInfo | undefined {
  const allPages = targets.filter((target) => selectableTargetTypes.has(target.type));
  const pages = allPages.filter((target) => target.webSocketDebuggerUrl !== undefined);
  const hasSelector = Boolean(selector.targetId || selector.url || selector.title);
  if (selector.targetId) {
    const page = allPages.find((target) => target.id === selector.targetId);
    if (page && page.webSocketDebuggerUrl === undefined) {
      throw new DiagnosticException("TARGET_NOT_FOUND", "指定的 target 没有可连接的 WebSocket 地址", {
        retryable: true,
        details: { selector: "targetId" },
      });
    }
    const exact = pages.find((target) => target.id === selector.targetId);
    if (exact) {
      return exact;
    }
    throw new DiagnosticException("TARGET_NOT_FOUND", "指定的 target 不存在", {
      details: { selector: "targetId" },
    });
  }
  if (selector.url) {
    const matches = allPages.filter((target) => target.url === selector.url);
    const available = matches.filter((target) => target.webSocketDebuggerUrl !== undefined);
    if (available.length > 1) {
      throw new DiagnosticException(
        "TARGET_SELECTION_REQUIRED",
        "多个可连接 page target 匹配 URL，请提供 targetId",
        { details: { selector: "url", count: available.length } },
      );
    }
    if (available.length === 1) {
      return available[0];
    }
    if (matches.length > 0) {
      throw new DiagnosticException("TARGET_NOT_FOUND", "指定的 target 没有可连接的 WebSocket 地址", {
        retryable: true,
        details: { selector: "url" },
      });
    }
  }
  if (selector.title) {
    const matches = allPages.filter((target) => target.title === selector.title);
    const available = matches.filter((target) => target.webSocketDebuggerUrl !== undefined);
    if (available.length > 1) {
      throw new DiagnosticException(
        "TARGET_SELECTION_REQUIRED",
        "多个可连接 page target 匹配标题，请提供 targetId",
        { details: { selector: "title", count: available.length } },
      );
    }
    if (available.length === 1) {
      return available[0];
    }
    if (matches.length > 0) {
      throw new DiagnosticException("TARGET_NOT_FOUND", "指定的 target 没有可连接的 WebSocket 地址", {
        retryable: true,
        details: { selector: "title" },
      });
    }
  }
  if (hasSelector) {
    throw new DiagnosticException("TARGET_NOT_FOUND", "没有匹配选择条件的 page target", {
      details: { selector },
    });
  }
  // An app that opens DevTools lists that window as one more page (`devtools://…`). It is never the window under
  // test, and dev builds often open it at startup, so it must not turn a single real window into an ambiguity. It
  // stays in the target list and can still be chosen explicitly.
  const windows = pages.filter((target) => target.type === "page");
  const candidates = windows.filter((target) => !target.url.startsWith("devtools://"));
  const automatic = candidates.length > 0 ? candidates : windows;
  if (automatic.length === 1) {
    return automatic[0];
  }
  if (automatic.length > 1) {
    throw new DiagnosticException(
      "TARGET_SELECTION_REQUIRED",
      "发现多个 page target，请提供 targetId、url 或 title",
      {
        hint: "应用有多个窗口或视图，自动选择会有选错的风险；对照返回的 targets 里的 title 和 url，选要验证的那一个。",
        details: { count: automatic.length },
      },
    );
  }
  throw new DiagnosticException("TARGET_NOT_FOUND", "没有可用的 page target", {
    retryable: true,
    hint: pages.length > 0
      ? "只发现了 <webview> 等嵌入页面，没有窗口；窗口可能还没创建或已经关闭。要检查嵌入页面时用 targetId 显式选择。"
      : "调试端口已打开，但应用还没有创建窗口，或窗口已全部关闭；等窗口出现后重试，或查看主进程日志里的创建错误。",
  });
}
