const sensitiveKey = "(?:access[_-]?token|refresh[_-]?token|id[_-]?token|token|secret|password|passwd|api[_-]?key|authorization|cookie)";
const keyValue = new RegExp(String.raw`((?:\\*["'])?${sensitiveKey}(?:\\*["'])?\s*[:=]\s*(?:\\*["'])?)(?:Bearer\s+)?[^\s"',;&}\\]+`, "gi");
const bearer = /\b(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/g;

export const redactedPlaceholder = "[REDACTED]";

export function redact(text: string): string {
  return text
    .replace(bearer, `$1${redactedPlaceholder}`)
    .replace(keyValue, `$1${redactedPlaceholder}`);
}
