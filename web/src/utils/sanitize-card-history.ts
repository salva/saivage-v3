const SECRET_LIKE_KEY_PATTERN = /(token|secret|password|authorization|auth[_-]?profile|provider|env|config)/i;
const SECRET_LIKE_VALUE_PATTERN = /(sk-[A-Za-z0-9_-]+|bearer\s+[A-Za-z0-9._-]+|api[_-]?key|token|secret|password|auth[_-]?profile|env\[[^\]]+\]|process\.env)/i;

/**
 * Sanitize a value for display in the card-history UI.
 *
 * - Object entries whose key matches `SECRET_LIKE_KEY_PATTERN` are replaced
 *   with `'[redacted]'` (value not recursed).
 * - String values matching `SECRET_LIKE_VALUE_PATTERN` are replaced with
 *   `'[redacted]'`.
 * - Arrays are mapped recursively; all other values pass through unchanged.
 *
 * Extracted verbatim (rules unchanged) from `CardHistoryPanel.vue` so the
 * shared `formatJson` redactor pipeline can reuse it.
 */
export function sanitizeCardHistoryValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeCardHistoryValue(item));
  }

  if (value && typeof value === 'object') {
    const sanitizedEntries = Object.entries(value as Record<string, unknown>).map(([key, entryValue]) => {
      if (SECRET_LIKE_KEY_PATTERN.test(key)) {
        return [key, '[redacted]'];
      }
      return [key, sanitizeCardHistoryValue(entryValue)];
    });
    return Object.fromEntries(sanitizedEntries);
  }

  if (typeof value === 'string' && SECRET_LIKE_VALUE_PATTERN.test(value)) {
    return '[redacted]';
  }

  return value;
}
