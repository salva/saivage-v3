import { redactTextForOutbound } from './text.js';

export function projectDynamicForOutbound(value: unknown): unknown {
  return projectValue(value, undefined, new WeakSet<object>());
}

function projectValue(value: unknown, key: string | undefined, activePath: WeakSet<object>): unknown {
  if (key !== undefined && isSecretKey(key) && (value === null || typeof value !== 'object')) {
    return neutralSecretValue(value);
  }
  if (typeof value === 'string') return redactTextForOutbound(value);
  if (typeof value === 'function') return undefined;
  if (value instanceof Error) return redactTextForOutbound(value.message);
  if (value === null || typeof value !== 'object') return value;
  if (activePath.has(value)) return '[Circular]';

  activePath.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((entry) => projectValue(entry, undefined, activePath));
    }

    const output: Record<string, unknown> = {};
    for (const [entryKey, entryValue] of Object.entries(value as Record<string, unknown>)) {
      output[entryKey] = projectValue(entryValue, entryKey, activePath);
    }
    return output;
  } finally {
    activePath.delete(value);
  }
}

function neutralSecretValue(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === 'boolean') return false;
  if (typeof value === 'number') return 0;
  if (typeof value === 'bigint') return 0n;
  return '[REDACTED]';
}

function isSecretKey(key: string): boolean {
  return /\b(?:apiKey|apiToken|botToken|accessToken|refreshToken|(?:api_)?key|token|authorization|.*[A-Z](?:Token|Key|Secret|Password)|.*_(?:key|token|secret|password)|secret|password|credential|credentials?|cookie|set-cookie|auth)\b/i.test(key);
}
