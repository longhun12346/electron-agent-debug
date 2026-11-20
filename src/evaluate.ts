import { DiagnosticException } from "./errors.js";
import { redact } from "./redact.js";
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
    exception?: { description?: string; value?: unknown };
  };
}

const requestGraceMs = 1_000;
// Chromium ignores awaitPromise for plain promises when replMode is on, but only replMode accepts top-level await
// and `let`/`const` redeclaration. Run without it first and retry in replMode on those early syntax errors (nothing ran).
const replOnlyError = /await is only valid|has already been declared/i;

function exceptionMessage(details: NonNullable<EvaluateResponse["exceptionDetails"]>): string {
  const exception = details.exception;
  const text = exception?.description ??
    (exception?.value === undefined ? undefined : String(exception.value)) ??
    details.text ?? "表达式执行失败";
  return redact(text).slice(0, 2_000);
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
    const run = async (replMode: boolean) => await session.request("Runtime.evaluate", {
      expression: options.expression,
      awaitPromise: options.awaitPromise,
      returnByValue: true,
      replMode,
      timeout: options.timeoutMs,
    }, options.timeoutMs + requestGraceMs) as EvaluateResponse;
    response = await run(false);
    if (response.exceptionDetails && replOnlyError.test(exceptionMessage(response.exceptionDetails))) {
      response = await run(true);
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
    return {
      type,
      text: object.unserializableValue,
      truncated: false,
      bytes: object.unserializableValue.length,
    };
  }
  if (object.value === undefined) {
    return { type, truncated: false, bytes: 0 };
  }

  const serialized = JSON.stringify(object.value) ?? "";
  const bytes = Buffer.byteLength(serialized, "utf8");
  const safe = redact(serialized);
  if (bytes > options.maxResultBytes) {
    return { type, text: truncateUtf8(safe, options.maxResultBytes), truncated: true, bytes };
  }
  try {
    return { type, value: JSON.parse(safe) as unknown, truncated: false, bytes };
  } catch {
    return { type, text: safe, truncated: false, bytes };
  }
}
