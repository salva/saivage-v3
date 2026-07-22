import { basename } from 'node:path';
import { looksLikeSecretPath } from './secret-paths.js';

const SECRET_KEY_RE = /(api[_-]?key|token|secret|password|passwd|credential|cookie|bearer|auth)/i;

export function isSecretLikeKey(key: string): boolean {
  return SECRET_KEY_RE.test(key) || looksLikeSecretPath(key) || looksLikeSecretPath(basename(key));
}

export function redactAnalystSecretValue(value: unknown, path: string[] = []): unknown {
  if (path.some((part) => isSecretLikeKey(part))) return '[REDACTED]';
  if (Array.isArray(value)) return value.map((item, index) => redactAnalystSecretValue(item, [...path, String(index)]));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      out[key] = isSecretLikeKey(key) ? '[REDACTED]' : redactAnalystSecretValue(child, [...path, key]);
    }
    return out;
  }
  return value;
}
