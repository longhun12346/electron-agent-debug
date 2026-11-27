import type { DiagnosticError } from "./types.js";

export class DiagnosticException extends Error {
  readonly diagnostic: DiagnosticError;

  constructor(
    code: string,
    message: string,
    options: {
      retryable?: boolean;
      hint?: string;
      details?: Record<string, unknown>;
      cause?: unknown;
    } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = "DiagnosticException";
    this.diagnostic = {
      code,
      message,
      retryable: options.retryable ?? false,
      ...(options.hint !== undefined ? { hint: options.hint } : {}),
      details: options.details,
    };
  }
}

export function toDiagnosticError(error: unknown, fallbackCode = "PROTOCOL_ERROR"): DiagnosticError {
  if (error instanceof DiagnosticException) {
    return error.diagnostic;
  }

  if (error instanceof Error) {
    return {
      code: fallbackCode,
      message: transportMessage(error),
      retryable: true,
    };
  }

  return {
    code: fallbackCode,
    message: "未知诊断错误",
    retryable: true,
  };
}

export function errorResult(error: DiagnosticError): {
  ok: false;
  error: DiagnosticError;
} {
  return { ok: false, error };
}

/** The system error code under a failed fetch or socket (ECONNREFUSED, ETIMEDOUT, …), when there is one. */
export function transportCode(error: unknown): string | undefined {
  for (let current = error, depth = 0; current !== undefined && current !== null && depth < 4; depth += 1) {
    const record = current as { code?: unknown; name?: unknown; cause?: unknown };
    if (typeof record.code === "string" && /^E[A-Z]+$/u.test(record.code)) return record.code;
    if (record.name === "TimeoutError") return "ETIMEDOUT";
    current = record.cause;
  }
  return undefined;
}

// `fetch failed` alone does not say whether nothing listens or the port is taken by something that never answers.
function transportMessage(error: Error): string {
  const code = transportCode(error);
  return code !== undefined && !error.message.includes(code) ? `${error.message} (${code})` : error.message;
}
