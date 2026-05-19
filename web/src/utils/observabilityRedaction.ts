const SECRET_KEY_RE = /(?:api[_-]?key|apiKey|apiToken|accessToken|refreshToken|token|authorization|secret|password|credential|cookie|set-cookie|auth)/i;
const JSON_SECRET_VALUE_RE = /("(?:[^"\\]|\\.)*")(\s*):(\s*)"((?:[^"\\]|\\.)*)"/gi;
const INLINE_SECRET_RE = /\b(api(?:[_-]?key|[_-]?token)?|token|authorization|secret|password|credential)\s*=\s*("[^"]*"|'[^']*'|\S+)/gi;
const CREDENTIAL_LITERAL_RE = /\b(sk-[^\s"\\]+|tid=[^\s"\\]+|ghu_[A-Za-z0-9_]+|rt_[^\s"\\]+|tok_[^\s"\\]+)\b/g;

function redactCredentialLiteral(match: string): string {
  if (match.startsWith('sk-')) return 'sk-[REDACTED]';
  if (match.startsWith('tid=')) return 'tid-[REDACTED]';
  if (match.startsWith('ghu_')) return 'ghu-[REDACTED]';
  if (match.startsWith('rt_')) return 'rt-[REDACTED]';
  if (match.startsWith('tok_')) return 'tok-[REDACTED]';
  return '[REDACTED]';
}

export function redactObservabilityText(value: string): string {
  return value
    .replace(JSON_SECRET_VALUE_RE, (match, keyPart: string, wsBefore: string, wsAfter: string, valuePart: string) => {
      const key = keyPart.slice(1, -1);
      if (!SECRET_KEY_RE.test(key)) return match;
      if (/\$\{[^}]+\}/.test(valuePart)) return match;
      return `${keyPart}${wsBefore}:${wsAfter}"[REDACTED]"`;
    })
    .replace(CREDENTIAL_LITERAL_RE, redactCredentialLiteral)
    .replace(INLINE_SECRET_RE, (_match, key: string) => `${key}=[REDACTED]`);
}

export function redactObservabilityValue<T>(value: T, keyHint?: string): T {
  if (typeof value === 'string') {
    return (keyHint && SECRET_KEY_RE.test(keyHint) ? '[REDACTED]' : redactObservabilityText(value)) as T;
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactObservabilityValue(item)) as T;
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, entryValue]) => [key, redactObservabilityValue(entryValue, key)])) as T;
  }
  return value;
}
