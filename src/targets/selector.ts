import { DiagnosticException } from "../errors.js";
import type { TargetInfo } from "../types.js";

export interface TargetSelector {
  targetId?: string;
  url?: string;
  title?: string;
}

export function selectTarget(targets: TargetInfo[], selector: TargetSelector): TargetInfo | undefined {
  const allPages = targets.filter((target) => target.type === "page");
  const pages = allPages.filter(
    (target) => target.type === "page" && target.webSocketDebuggerUrl !== undefined,
  );
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
    const page = allPages.find((target) => target.url === selector.url);
    if (page && page.webSocketDebuggerUrl === undefined) {
      throw new DiagnosticException("TARGET_NOT_FOUND", "指定的 target 没有可连接的 WebSocket 地址", {
        retryable: true,
        details: { selector: "url" },
      });
    }
    const exact = pages.find((target) => target.url === selector.url);
    if (exact) {
      return exact;
    }
  }
  if (selector.title) {
    const page = allPages.find((target) => target.title === selector.title);
    if (page && page.webSocketDebuggerUrl === undefined) {
      throw new DiagnosticException("TARGET_NOT_FOUND", "指定的 target 没有可连接的 WebSocket 地址", {
        retryable: true,
        details: { selector: "title" },
      });
    }
    const exact = pages.find((target) => target.title === selector.title);
    if (exact) {
      return exact;
    }
  }
  if (hasSelector) {
    throw new DiagnosticException("TARGET_NOT_FOUND", "没有匹配选择条件的 page target", {
      details: { selector },
    });
  }
  if (pages.length === 1) {
    return pages[0];
  }
  if (pages.length > 1) {
    throw new DiagnosticException(
      "TARGET_SELECTION_REQUIRED",
      "发现多个 page target，请提供 targetId、url 或 title",
      { details: { count: pages.length } },
    );
  }
  throw new DiagnosticException("TARGET_NOT_FOUND", "没有可用的 page target", { retryable: true });
}
