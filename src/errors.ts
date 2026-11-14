import type { DiagnosticError } from "./types.js";

export class DiagnosticException extends Error {
  readonly diagnostic: DiagnosticError;

  constructor(
    code: string,
    message: string,
    options: {
      retryable?: boolean;
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
      message: error.message,
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

export function successResult<T>(data: T): { ok: true; data: T } {
  return { ok: true, data };
}
