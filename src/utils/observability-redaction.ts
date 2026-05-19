import { isSecretKey, redactProviderLikeText } from './secret-redaction.js';

function redactText(value: string): string {
  return redactProviderLikeText(value);
}

export function redactObservabilityValue<T>(value: T, keyHint?: string): T {
  if (typeof value === 'string') {
    return (keyHint && isSecretKey(keyHint) ? '[REDACTED]' : redactText(value)) as T;
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
