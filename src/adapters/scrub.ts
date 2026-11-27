/**
 * Secret redaction for anything a coding CLI prints before it is written to a record. Records are
 * committed, so this is applied to raw events, stderr, and final messages alike. Redaction keeps
 * line structure and JSON string boundaries, so JSONL stays parseable and line-addressable.
 */
export const REDACTED = '[redacted]';

const PATTERNS: Array<[RegExp, string]> = [
  // JSON or key=value fields whose name marks a credential.
  [/("(?:[a-z_]*?(?:token|secret|password|api_?key|authorization|cookie)[a-z_]*)"\s*:\s*")(?!\[redacted\])[^"\\\n]*(?:\\.[^"\\\n]*)*(")/gi, `$1${REDACTED}$2`],
  [/\b((?:[A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|API_KEY|APIKEY))\s*=\s*)(?!\[redacted\])[^\s"']+/g, `$1${REDACTED}`],
  [/\b(Bearer\s+)(?!\[redacted\])[A-Za-z0-9._~+/=-]{8,}/g, `$1${REDACTED}`],
  // Provider key shapes (OpenAI sk-…, sk-proj-…, Anthropic sk-ant-…).
  [/\bsk-[A-Za-z0-9_-]{16,}/g, REDACTED],
  // JWT-shaped tokens (ChatGPT access/id tokens).
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, REDACTED],
];

export function scrubSecrets(text: string): string {
  let out = text;
  for (const [re, rep] of PATTERNS) out = out.replace(re, rep);
  return out;
}
