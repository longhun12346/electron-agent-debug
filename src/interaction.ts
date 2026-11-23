import { randomInt } from "node:crypto";
import { DiagnosticException } from "./errors.js";
import { redact } from "./redact.js";
import type { AxNode } from "./ax-tree.js";
import type { DiagnosticSession } from "./sessions/diagnostic-session.js";

/**
 * Click and type on elements that the last accessibility snapshot tagged with a ref, using CDP Input events so the
 * page sees trusted input (`isTrusted` is true). Measured on Electron 43:
 * - DOM.getContentQuads returns CSS pixels relative to the viewport after DOM.scrollIntoViewIfNeeded, on 2x screens
 *   too, so the centre of a quad can be used for Input.dispatchMouseEvent as it is.
 * - DOM.getNodeForLocation at that point tells a covered element apart: the click is refused instead of landing on
 *   the overlay.
 * - Input.insertText into a focused, selected field replaces its content, sends a trusted `input` event, takes CJK
 *   text, and is kept by React-style controlled inputs (a direct `.value` write is undone by them).
 * - Hidden windows (`show: false`) take input; a minimized window may drop it, which shows up as a timeout.
 */

interface RefEntry {
  ref: string;
  backendNodeId: number;
  targetId: string;
  role: string;
  name: string;
}

/** Refs look like `kqx12`: a per-process prefix and a number. */
export const refPattern = /^[a-z]{3}\d+$/u;

// Three letters (about 13,800 prefixes) keep the chance that two runs share a prefix small.
function randomPrefix(): string {
  const letters = "abcdefghijkmnpqrstuvwxyz";
  let prefix = "";
  for (let index = 0; index < 3; index += 1) prefix += letters[randomInt(letters.length)]!;
  return prefix;
}

/** What electron_click and electron_type accept in place of a ref: the role and name a snapshot line shows. */
export interface ElementLocator {
  role: string;
  name: string;
}

/**
 * Refs of the latest snapshot of the selected page. A node keeps its ref across snapshots of the same page, so an
 * agent can reuse a ref after taking a fresh snapshot; refs that are not in the latest snapshot are rejected.
 *
 * Every registry numbers with its own random prefix. Batch mode starts a new process for every run, and without the
 * prefix each run would number from 1 again: a ref read in one run would name a different element in the next once the
 * page changed (measured: a Save ref clicked the Name textbox after a button was inserted above it, and reported ok).
 * With the prefix such a ref is unknown and rejected.
 */
export class RefRegistry {
  private next = 1;
  readonly prefix: string;
  private targetId?: string;
  private byBackend = new Map<number, string>();
  private latest = new Map<string, RefEntry>();

  constructor(prefix = randomPrefix()) {
    this.prefix = prefix;
  }

  /** Starts a snapshot of `targetId` and returns the assigner for renderAxTree. */
  begin(targetId: string): (node: AxNode, role: string, name: string) => string | undefined {
    if (this.targetId !== targetId) {
      this.targetId = targetId;
      this.byBackend = new Map();
    }
    this.latest = new Map();
    return (node, role, name) => {
      const backendNodeId = node.backendDOMNodeId;
      if (backendNodeId === undefined) return undefined;
      let ref = this.byBackend.get(backendNodeId);
      if (ref === undefined) {
        ref = `${this.prefix}${this.next++}`;
        this.byBackend.set(backendNodeId, ref);
      }
      this.latest.set(ref, { ref, backendNodeId, targetId, role, name });
      return ref;
    };
  }

  resolve(ref: string, currentTargetId: string | undefined): RefEntry {
    const entry = this.latest.get(ref);
    if (!entry) {
      const otherProcess = !ref.startsWith(this.prefix);
      throw new DiagnosticException("REF_NOT_FOUND", `ref ${ref} 不在最近一次 electron_dom_snapshot 的结果里`, {
        hint: otherProcess
          ? "这个 ref 来自另一次运行（批处理每次执行都是新进程，MCP Server 重启后也一样），在这里无效。" +
            "批处理里改用 role 和 name 定位（如 {role: \"button\", name: \"Save\"}），或在同一次执行里先取快照。"
          : "先调用 electron_dom_snapshot，用它返回的 [ref=…]；ref 只对当前页面最近一次快照有效。",
        details: { ref },
      });
    }
    if (entry.targetId !== currentTargetId) {
      throw new DiagnosticException("REF_STALE", `ref ${ref} 属于另一个页面`, {
        hint: "选中的页面已经变了；对当前页面重新调用 electron_dom_snapshot 取新的 ref。",
        details: { ref, refTargetId: entry.targetId, selectedTargetId: currentTargetId },
      });
    }
    return entry;
  }

  /**
   * The element of the latest snapshot with exactly this role and name. Several matches are refused with the
   * candidates rather than guessed between; no match lists elements whose name contains the requested one.
   */
  find(locator: ElementLocator): RefEntry {
    const name = locator.name.replace(/\s+/gu, " ").trim();
    const entries = [...this.latest.values()];
    const matches = entries.filter((entry) => entry.role === locator.role && entry.name === name);
    if (matches.length === 1) return matches[0]!;
    const list = (candidates: RefEntry[]) => candidates.slice(0, 10).map(describeEntry);
    if (matches.length > 1) {
      throw new DiagnosticException("ELEMENT_AMBIGUOUS", `页面上有 ${matches.length} 个 ${locator.role} "${name}"`, {
        hint: "按 role 和 name 无法确定是哪一个；取快照对照上下文后用 ref 指定。",
        details: { ...locator, candidates: list(matches) },
      });
    }
    const lowered = name.toLowerCase();
    const similar = entries.filter((entry) => entry.name.toLowerCase().includes(lowered) ||
      (entry.role === locator.role && lowered.includes(entry.name.toLowerCase()) && entry.name !== ""));
    throw new DiagnosticException("ELEMENT_NOT_FOUND", `页面上没有 ${locator.role} "${name}"`, {
      retryable: true,
      hint: similar.length
        ? "name 要与快照里显示的完全一致（区分大小写）；details.candidates 是名字相近的元素。"
        : "元素可能还没渲染出来，用 electron_wait_for 等它出现；或用 electron_dom_snapshot 查看实际的 role 和 name。",
      details: { ...locator, candidates: list(similar) },
    });
  }

  clear(): void {
    this.targetId = undefined;
    this.byBackend = new Map();
    this.latest = new Map();
  }
}

const objectGroup = "electron-agent-debug-input";
const inputTimeoutMs = 3_000;

type Quad = [number, number, number, number, number, number, number, number];

function area(quad: Quad): number {
  let sum = 0;
  for (let index = 0; index < 4; index += 1) {
    const [x1, y1] = [quad[index * 2]!, quad[index * 2 + 1]!];
    const [x2, y2] = [quad[((index + 1) % 4) * 2]!, quad[((index + 1) % 4) * 2 + 1]!];
    sum += x1 * y2 - x2 * y1;
  }
  return Math.abs(sum) / 2;
}

function describeEntry(entry: RefEntry): { ref: string; role: string; name: string } {
  return { ref: entry.ref, role: entry.role, name: entry.name };
}

/** An error response from the page to a CDP command, as opposed to a timeout or a lost or crashed session. */
function isCommandError(error: unknown): boolean {
  return error instanceof DiagnosticException && error.diagnostic.code === "PROTOCOL_ERROR" &&
    error.diagnostic.details?.reason !== "timeout";
}

// Node ids of a document that was reloaded or replaced no longer resolve.
async function resolveObject(session: DiagnosticSession, entry: RefEntry): Promise<string> {
  try {
    const response = await session.request("DOM.resolveNode", { backendNodeId: entry.backendNodeId, objectGroup }) as {
      object?: { objectId?: string };
    };
    if (typeof response.object?.objectId !== "string") throw new Error("no object");
    return response.object.objectId;
  } catch (error) {
    if (error instanceof DiagnosticException && !isCommandError(error)) throw error;
    throw new DiagnosticException("REF_STALE", `ref ${entry.ref} 对应的元素已不在页面上`, {
      hint: "页面重新加载、跳转或重新渲染过；重新调用 electron_dom_snapshot 取新的 ref。",
      details: describeEntry(entry),
    });
  }
}

async function callOn<T>(session: DiagnosticSession, objectId: string, fn: string, args: unknown[] = []): Promise<T> {
  const response = await session.request("Runtime.callFunctionOn", {
    objectId,
    functionDeclaration: fn,
    arguments: args,
    returnByValue: true,
    awaitPromise: true,
  }) as { result?: { value?: unknown }; exceptionDetails?: { text?: string; exception?: { description?: string } } };
  if (response.exceptionDetails) {
    throw new DiagnosticException("INTERACTION_FAILED",
      response.exceptionDetails.exception?.description ?? response.exceptionDetails.text ?? "页面内脚本执行失败");
  }
  return response.result?.value as T;
}

async function scrollAndCentre(session: DiagnosticSession, entry: RefEntry): Promise<{ x: number; y: number }> {
  const notVisible = (cause?: unknown) => new DiagnosticException("ELEMENT_NOT_VISIBLE", `ref ${entry.ref} 对应的元素没有可点击的区域`, {
    hint: "元素可能被隐藏（display:none、尺寸为 0）或还没渲染出来；用 electron_wait_for 等它出现后重新取快照。",
    details: describeEntry(entry),
    cause,
  });
  try {
    await session.request("DOM.scrollIntoViewIfNeeded", { backendNodeId: entry.backendNodeId });
  } catch (error) {
    // Only a rejected command means the element has no layout; a timeout or a lost connection stays what it is.
    if (!isCommandError(error)) throw error;
    throw notVisible(error);
  }
  const response = await session.request("DOM.getContentQuads", { backendNodeId: entry.backendNodeId }) as {
    quads?: Quad[];
  };
  const quads = (response.quads ?? []).filter((quad) => area(quad) >= 1);
  if (quads.length === 0) throw notVisible();
  const quad = quads.reduce((best, candidate) => (area(candidate) > area(best) ? candidate : best));
  return {
    x: (quad[0] + quad[2] + quad[4] + quad[6]) / 4,
    y: (quad[1] + quad[3] + quad[5] + quad[7]) / 4,
  };
}

// Quads and Input events use viewport coordinates, but DOM.getNodeForLocation takes document coordinates: on a
// scrolled page the scroll offset has to be added, or the hit test looks at the wrong place (measured: "No node found
// at given location" for a button scrolled into view at the bottom of a long page).
async function hitTest(session: DiagnosticSession, point: { x: number; y: number }): Promise<{ backendNodeId?: number }> {
  const metrics = await session.request("Page.getLayoutMetrics", {}) as {
    cssVisualViewport?: { pageX?: number; pageY?: number };
  };
  const x = Math.round(point.x + (metrics.cssVisualViewport?.pageX ?? 0));
  const y = Math.round(point.y + (metrics.cssVisualViewport?.pageY ?? 0));
  try {
    return await session.request("DOM.getNodeForLocation", {
      x, y, includeUserAgentShadowDOM: false, ignorePointerEventsNone: true,
    }) as { backendNodeId?: number };
  } catch (error) {
    if (!isCommandError(error)) throw error;
    return {};
  }
}

// True when a click on `hit` reaches `this`: the element itself, something inside it (also across shadow roots), or
// a label that activates it.
const reachesTarget = `function (hit) {
  for (let node = hit; node; node = node.parentNode || node.host) {
    if (node === this) return true;
  }
  const label = hit && hit.closest ? hit.closest('label') : null;
  return !!label && label.control === this;
}`;

const describeElement = `function () {
  const text = (this.innerText || this.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 80);
  return { tag: this.localName, id: this.id || undefined,
    className: typeof this.className === 'string' && this.className ? this.className.slice(0, 80) : undefined,
    text: text || undefined };
}`;

const stateOf = `function () {
  const disabled = this.disabled === true || this.getAttribute('aria-disabled') === 'true' ||
    !!(this.closest && this.closest('fieldset[disabled]'));
  const tag = this.localName;
  const nonText = ['button', 'checkbox', 'radio', 'submit', 'reset', 'file', 'image', 'color', 'range', 'hidden'];
  const editable = this.isContentEditable ||
    tag === 'textarea' || (tag === 'input' && !nonText.includes((this.type || 'text').toLowerCase()));
  const readOnly = this.readOnly === true || this.getAttribute('aria-readonly') === 'true';
  return { disabled, editable, readOnly, password: tag === 'input' && this.type === 'password' };
}`;

async function elementState(session: DiagnosticSession, objectId: string): Promise<{
  disabled: boolean; editable: boolean; readOnly: boolean; password: boolean;
}> {
  return callOn(session, objectId, stateOf);
}

async function dispatch(session: DiagnosticSession, method: string, params: Record<string, unknown>): Promise<void> {
  try {
    await session.request(method, params, inputTimeoutMs);
  } catch (error) {
    if (!(error instanceof DiagnosticException) || error.diagnostic.details?.reason !== "timeout" ||
      error.diagnostic.hint !== undefined) {
      throw error;
    }
    let hidden = false;
    try {
      const state = await session.request("Runtime.evaluate", {
        expression: "document.visibilityState", returnByValue: true,
      }, 1_000) as { result?: { value?: unknown } };
      hidden = state.result?.value === "hidden";
    } catch {
      // The page did not answer either; the timeout stays unexplained.
    }
    throw new DiagnosticException(error.diagnostic.code, error.diagnostic.message, {
      retryable: true,
      hint: hidden
        ? "窗口被最小化或隐藏时 Chromium 可能不处理输入事件；先恢复窗口（例如主进程里 BrowserWindow 的 restore() 或 show()）再重试。"
        : "页面没有及时处理输入事件；看 electron_status 里有没有打开的对话框，或页面是否卡住。",
      details: error.diagnostic.details,
      cause: error,
    });
  }
}

/** An element is given either by a snapshot ref or by role and name. */
export type ElementTarget = { ref: string } | ElementLocator;

export type ClickInput = ElementTarget & { doubleClick?: boolean };

export type TypeInput = ElementTarget & {
  text: string;
  clear?: boolean;
  submit?: boolean;
};

function entryFor(session: DiagnosticSession, refs: RefRegistry, target: ElementTarget): RefEntry {
  return "ref" in target ? refs.resolve(target.ref, session.snapshot().selectedTarget?.id) : refs.find(target);
}

export async function clickRef(session: DiagnosticSession, refs: RefRegistry, input: ClickInput): Promise<Record<string, unknown>> {
  const entry = entryFor(session, refs, input);
  try {
    const objectId = await resolveObject(session, entry);
    const state = await elementState(session, objectId);
    if (state.disabled) {
      throw new DiagnosticException("ELEMENT_DISABLED", `ref ${entry.ref} 对应的元素处于禁用状态`, {
        hint: "禁用的元素不响应点击；先确认让它启用的前置条件，再重试。",
        details: describeEntry(entry),
      });
    }
    const point = await scrollAndCentre(session, entry);
    const hit = await hitTest(session, point);
    if (hit.backendNodeId !== entry.backendNodeId) {
      const hitObject = hit.backendNodeId === undefined
        ? undefined
        : await session.request("DOM.resolveNode", { backendNodeId: hit.backendNodeId, objectGroup }) as {
          object?: { objectId?: string };
        };
      const hitId = hitObject?.object?.objectId;
      const reaches = hitId !== undefined &&
        await callOn<boolean>(session, objectId, reachesTarget, [{ objectId: hitId }]);
      if (!reaches) {
        const coveredBy = hitId !== undefined ? await callOn<Record<string, unknown>>(session, hitId, describeElement) : undefined;
        throw new DiagnosticException("ELEMENT_COVERED", `ref ${entry.ref} 对应的元素被其他元素挡住，没有点击`, {
          hint: "元素中心被遮罩、弹层或悬浮元素挡住了；先关闭挡住它的东西，或等动画结束后重新取快照再点。",
          details: { ...describeEntry(entry), coveredBy: coveredBy ? JSON.parse(redact(JSON.stringify(coveredBy))) : undefined },
        });
      }
    }
    const x = point.x;
    const y = point.y;
    await dispatch(session, "Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "none" });
    for (const clickCount of input.doubleClick ? [1, 2] : [1]) {
      await dispatch(session, "Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", buttons: 1, clickCount });
      await dispatch(session, "Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", buttons: 0, clickCount });
    }
    return { ...describeEntry(entry), x: Math.round(x), y: Math.round(y), doubleClick: input.doubleClick === true };
  } finally {
    await session.request("Runtime.releaseObjectGroup", { objectGroup }).catch(() => undefined);
  }
}

const selectContents = `function (clear) {
  this.focus();
  if (this.isContentEditable) {
    const range = document.createRange();
    range.selectNodeContents(this);
    if (!clear) range.collapse(false);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    return;
  }
  if (clear) this.select();
  else if (typeof this.setSelectionRange === 'function') {
    try { this.setSelectionRange(this.value.length, this.value.length); } catch {}
  }
}`;

const readValue = `function () {
  return this.isContentEditable ? (this.innerText || '') : String(this.value ?? '');
}`;

export async function typeRef(session: DiagnosticSession, refs: RefRegistry, input: TypeInput): Promise<Record<string, unknown>> {
  const entry = entryFor(session, refs, input);
  const clear = input.clear !== false;
  try {
    const objectId = await resolveObject(session, entry);
    const state = await elementState(session, objectId);
    if (!state.editable || state.disabled || state.readOnly) {
      throw new DiagnosticException("ELEMENT_NOT_EDITABLE", `ref ${entry.ref} 对应的元素不能输入文字`, {
        hint: state.editable
          ? "元素是禁用或只读的；先确认让它可编辑的前置条件。"
          : "只能输入到文本框、textarea 或 contenteditable 元素；下拉框、复选框用 electron_click，原生 <select> 用 electron_evaluate 设值。",
        details: { ...describeEntry(entry), disabled: state.disabled, readOnly: state.readOnly },
      });
    }
    await scrollAndCentre(session, entry);
    await callOn(session, objectId, selectContents, [{ value: clear }]);
    if (input.text !== "") {
      await dispatch(session, "Input.insertText", { text: input.text });
    } else if (clear) {
      for (const type of ["keyDown", "keyUp"]) {
        await dispatch(session, "Input.dispatchKeyEvent", { type, key: "Delete", code: "Delete", windowsVirtualKeyCode: 46 });
      }
    }
    if (input.submit) {
      await dispatch(session, "Input.dispatchKeyEvent", {
        type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r", unmodifiedText: "\r",
      });
      await dispatch(session, "Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
    }
    // The field may be gone after a submit; its value is then simply not reported.
    let value: string | undefined;
    try {
      const raw = await callOn<string>(session, objectId, readValue);
      value = state.password ? "[REDACTED]" : redact(raw.length > 500 ? `${raw.slice(0, 500)}…` : raw);
    } catch {
      value = undefined;
    }
    return { ...describeEntry(entry), ...(value !== undefined ? { value } : {}), cleared: clear, submitted: input.submit === true };
  } finally {
    await session.request("Runtime.releaseObjectGroup", { objectGroup }).catch(() => undefined);
  }
}
