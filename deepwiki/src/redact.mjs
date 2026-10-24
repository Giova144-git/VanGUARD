// Regla: nada que parezca secreto sale hacia un modelo.
const PATTERNS = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /sk-ant-[A-Za-z0-9_-]{10,}/g,
  /\b(?:sk|pk|rk)-[A-Za-z0-9]{20,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
  /((?:secret|token|passw(?:or)?d|api[_-]?key|private[_-]?key)["']?\s*[:=]\s*["']?)[^\s"',]{6,}/gi,
];
export function redact(text) {
  let out = text;
  for (const re of PATTERNS) out = out.replace(re, (m, p1) => (typeof p1 === 'string' ? `${p1}[REDACTADO]` : '[REDACTADO]'));
  return out;
}
