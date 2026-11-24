import { DiagnosticException } from "./errors.js";
import type { DiagnosticSession } from "./sessions/diagnostic-session.js";

export interface EvaluateOptions {
  expression: string;
  awaitPromise: boolean;
  timeoutMs: number;
  maxResultBytes: number;
}

export interface EvaluateResult {
  type: string;
  value?: unknown;
  text?: string;
  truncated: boolean;
  bytes: number;
}

interface RemoteObject {
  type?: string;
  subtype?: string;
  value?: unknown;
  unserializableValue?: string;
  description?: string;
}

interface EvaluateResponse {
  result?: RemoteObject;
  exceptionDetails?: {
    text?: string;
    lineNumber?: number;
    columnNumber?: number;
    stackTrace?: unknown;
    exception?: { description?: string; value?: unknown };
  };
}

const requestGraceMs = 1_000;
// Chromium ignores awaitPromise for plain promises when replMode is on, but only replMode accepts top-level await
// and `let`/`const` redeclaration. Run without it first and retry in replMode when the code did not even compile.
//
// A compile-time SyntaxError is told apart from one thrown by running code (JSON.parse, new Function) by its missing
// stack trace, not by its wording: V8 words the same mistake differently ("await is only valid…" for `await x`,
// "Unexpected token 'import'" for `await import(…)`), and a wording match silently misses the next variant. Nothing
// has run when the code fails to compile, so trying again in another mode cannot repeat a side effect.
const redeclarationError = /has already been declared/i;
// replMode can only redeclare bindings that were themselves created in replMode. A `let`/`const` left behind by an
// earlier plain evaluation stays in the way, so as a last resort run the code in a block: the block's completion
// value is still the result, and its declarations shadow the old ones instead of colliding (they do not persist).

// `await (…)`, ``await `t` `` and `await -1` parse in plain mode as an operation on a variable named await. That fails
// at run time with a ReferenceError the moment the identifier is evaluated, so when only whitespace precedes it nothing
// else has run and a retry is as safe as for a compile error. Anywhere else earlier statements may have run: those are
// not retried, and the error says what to write instead.
const awaitAsCallHint =
  "（顶层 await 后面直接跟括号、负号等会被当成对名为 await 的变量的操作；把操作数放进变量再 await，或写成 (async () => { … })()）";

function exceptionMessage(details: NonNullable<EvaluateResponse["exceptionDetails"]>): string {
  const exception = details.exception;
  const text = exception?.description ??
    (exception?.value === undefined ? undefined : String(exception.value)) ??
    details.text ?? "表达式执行失败";
  const message = text.slice(0, 2_000);
  return /^ReferenceError: await is not defined/u.test(message) ? `${message}${awaitAsCallHint}` : message;
}

function blankBefore(expression: string, line: number, column: number): boolean {
  const lines = expression.split("\n");
  return [...lines.slice(0, line), (lines[line] ?? "").slice(0, column)].join("\n").trim() === "";
}

function ranNothing(details: NonNullable<EvaluateResponse["exceptionDetails"]>, expression: string): boolean {
  const description = details.exception?.description ?? "";
  if (details.stackTrace === undefined && /^SyntaxError\b/u.test(description)) {
    return true;
  }
  return /^ReferenceError: await is not defined/u.test(description) &&
    typeof details.lineNumber === "number" && typeof details.columnNumber === "number" &&
    blankBefore(expression, details.lineNumber, details.columnNumber);
}

// Cut to at most maxBytes of UTF-8 without splitting a multi-byte character.
function truncateUtf8(text: string, maxBytes: number): string {
  const buffer = Buffer.from(text, "utf8");
  if (buffer.length <= maxBytes) {
    return text;
  }
  let end = maxBytes;
  while (end > 0 && (buffer[end]! & 0xc0) === 0x80) {
    end -= 1;
  }
  return buffer.subarray(0, end).toString("utf8");
}

export async function evaluateExpression(
  session: DiagnosticSession,
  options: EvaluateOptions,
): Promise<EvaluateResult> {
  let response: EvaluateResponse;
  try {
    const run = async (expression: string, replMode: boolean) => await session.request("Runtime.evaluate", {
      expression,
      awaitPromise: options.awaitPromise,
      returnByValue: true,
      replMode,
      timeout: options.timeoutMs,
    }, options.timeoutMs + requestGraceMs) as EvaluateResponse;
    const failsWith = (pattern: RegExp) =>
      response.exceptionDetails !== undefined && pattern.test(exceptionMessage(response.exceptionDetails));
    const failsToCompile = (expression: string) =>
      response.exceptionDetails !== undefined && ranNothing(response.exceptionDetails, expression);
    // A redeclaration error counts only when it is a compile error: the same words can come from code that already ran
    // (`eval("let q; let q")` throws at run time, with a stack), and running that again would repeat its side effects.
    const redeclared = (expression: string) => failsWith(redeclarationError) && failsToCompile(expression);
    response = await run(options.expression, false);
    if (failsToCompile(options.expression) || redeclared(options.expression)) {
      response = await run(options.expression, true);
    }
    if (redeclared(options.expression)) {
      const block = `{${options.expression}\n}`;
      response = await run(block, false);
      if (failsToCompile(block)) {
        response = await run(block, true);
      }
    }
  } catch (error) {
    if (error instanceof DiagnosticException && error.diagnostic.code === "PROTOCOL_ERROR" &&
        /by value|reference chain|serializ/i.test(error.message)) {
      throw new DiagnosticException(
        "EVALUATION_FAILED",
        `结果无法按值返回：${error.message}。请返回可 JSON 序列化的值`,
        { cause: error },
      );
    }
    throw error;
  }

  if (response.exceptionDetails) {
    const { lineNumber, columnNumber } = response.exceptionDetails;
    throw new DiagnosticException("EVALUATION_FAILED", exceptionMessage(response.exceptionDetails), {
      details: { lineNumber, columnNumber },
    });
  }

  const object = response.result ?? {};
  const type = object.subtype ? `${object.type}:${object.subtype}` : object.type ?? "undefined";
  if (object.unserializableValue !== undefined) {
    const bytes = Buffer.byteLength(object.unserializableValue, "utf8");
    return {
      type,
      text: truncateUtf8(object.unserializableValue, options.maxResultBytes),
      truncated: bytes > options.maxResultBytes,
      bytes,
    };
  }
  if (object.value === undefined) {
    return { type, truncated: false, bytes: 0 };
  }

  const serialized = JSON.stringify(object.value) ?? "";
  const bytes = Buffer.byteLength(serialized, "utf8");
  const safe = serialized;
  if (bytes > options.maxResultBytes) {
    return { type, text: truncateUtf8(safe, options.maxResultBytes), truncated: true, bytes };
  }
  try {
    return { type, value: JSON.parse(safe) as unknown, truncated: false, bytes };
  } catch {
    return { type, text: safe, truncated: false, bytes };
  }
}
