import { redactCredentialLiterals, redactSecrets } from './file-access-security.js';

const SECRET_KEY_RE = /(?:api[_-]?key|apiKey|apiToken|accessToken|refreshToken|token|authorization|secret|password|credential|cookie|set-cookie|auth)/i;
const INLINE_SECRET_RE = /\b(api(?:[_-]?key|[_-]?token)?|token|authorization|secret|password|credential)\s*=\s*("[^"]*"|'[^']*'|\S+)/gi;

function redactText(value: string): string {
  return redactSecrets(redactCredentialLiterals(value)).replace(INLINE_SECRET_RE, (_match, key: string) => `${key}=[REDACTED]`);
}

export function redactObservabilityValue<T>(value: T, keyHint?: string): T {
  if (typeof value === 'string') {
    return (keyHint && SECRET_KEY_RE.test(keyHint) ? '[REDACTED]' : redactText(value)) as T;
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactObservabilityValue(item)) as T;
  }
  if (value && typeof value === 'object') {
    const output: Record<string, unknown> = {};
    for (const [key, entryValue] of Object.entries(value as Record<string, unknown>)) {
      output[key] = redactObservabilityValue(entryValue, key);
    }
    return output as T;
  }
  return value;
}

export function redactObservabilityText(value: string): string {
  return redactText(value);
}
