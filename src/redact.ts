const sensitiveKey = "(?:access[_-]?token|refresh[_-]?token|id[_-]?token|token|secret|password|passwd|api[_-]?key|authorization|cookie)";
const keyValue = new RegExp(String.raw`((?:\\*["'])?${sensitiveKey}(?:\\*["'])?\s*[:=]\s*(?:\\*["'])?)(?:Bearer\s+)?[^\s"',;&}\\]+`, "gi");
const bearer = /\b(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/g;

// Secrets that carry no key name to match on: they are recognised by their shape. Each pattern needs a distinctive
// prefix and a minimum length, so ordinary words, hashes and ids are left alone.
const jsonWebToken = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g;
const prefixedToken = new RegExp(
  [
    String.raw`\bgh[pousr]_[A-Za-z0-9]{30,}`,
    String.raw`\bgithub_pat_[A-Za-z0-9_]{30,}`,
    String.raw`\bsk-(?:ant-|proj-)?(?=[A-Za-z0-9_-]*\d)[A-Za-z0-9_-]{20,}`,
    String.raw`\bxox[abprs]-[A-Za-z0-9-]{10,}`,
    String.raw`\bnpm_[A-Za-z0-9]{30,}`,
    String.raw`\bAKIA[0-9A-Z]{16}\b`,
    String.raw`\bAIza[0-9A-Za-z_-]{35,}`,
  ].join("|"),
  "g",
);
// The body is base64 plus whitespace or the escaped newlines of a JSON string. A key cut off by truncation has no END
// line, so the match ends at the first character that cannot belong to the key.
const privateKey = /-----BEGIN [A-Z ]*PRIVATE KEY-----(?:[A-Za-z0-9+/=\s]|\\[nr])*(?:-----END [A-Z ]*PRIVATE KEY-----)?/g;
const urlPassword = /(\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@"']+:)[^\s/@"']+(?=@)/gi;

export const redactedPlaceholder = "[REDACTED]";

export function redact(text: string): string {
  return text
    .replace(privateKey, redactedPlaceholder)
    .replace(bearer, `$1${redactedPlaceholder}`)
    .replace(keyValue, `$1${redactedPlaceholder}`)
    .replace(jsonWebToken, redactedPlaceholder)
    .replace(prefixedToken, redactedPlaceholder)
    .replace(urlPassword, `$1${redactedPlaceholder}`);
}
