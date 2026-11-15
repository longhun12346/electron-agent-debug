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
