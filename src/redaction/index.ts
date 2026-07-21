export const SECRET_REDACTION_PLACEHOLDER = '[REDACTED]';

export interface StructuredRedactionOptions {
  maxDepth?: number;
  maxEntries?: number;
}

const SECRET_KEY_PATTERN =
  /\b(?:apiKey|apiToken|botToken|accessToken|refreshToken|(?:api_)?key|token|authorization|.*[A-Z](?:Token|Key|Secret|Password)|.*_(?:key|token|secret|password)|secret|password|credential|credentials?|cookie|set-cookie|auth)\b/i;

const JSON_SECRET_VALUE_RE =
  /("(?:[^"\\]|\\.)*")(\s*):(\s*)"((?:[^"\\]|\\.)*)"/gi;
const YAML_SECRET_VALUE_RE = /(^[ \t]*([A-Za-z][A-Za-z0-9_-]*)[ \t]*:[ \t]*)([^\n#][^\n]*)(?=$|\n)/gmi;
const ESCAPED_JSON_SECRET_VALUE_RE = /(\\")([^"\\]+)(\\")(\s*:\s*)(\\")([^"\\]*)(\\")/gi;
const INLINE_SECRET_ASSIGNMENT_RE = /\b([A-Za-z][A-Za-z0-9_-]*(?:(?:credential|credentials|secret|password|token|authorization|auth|api[_-]?key|apiKey|cookie|set-cookie)[A-Za-z0-9_-]*)?)\s*=\s*("[^"]*"|'[^']*'|\S+)/gi;
const CREDENTIAL_LITERAL_RE = /\b(sk-[^\s"\\]+|tid=[^\s"\\]+|ghu_[A-Za-z0-9_]+|rt_[^\s"\\]+|tok_[^\s"\\]+)\b/g;
const BEARER_CREDENTIAL_RE = /\b(Bearer\s+)([^\s"\\]+)/gi;
const URL_SECRET_QUERY_PARAM_RE =
  /([?&][^=&#\s]*(?:credential|credentials|secret|password|token|authorization|auth|api[_-]?key|apiKey|cookie|set-cookie)[^=&#\s]*=)([^&#\s]+)/gi;

const CONVERSION_FAILURE = '[unserializable dynamic value]';
const DEFAULT_MAX_DEPTH = 8;
const DEFAULT_MAX_ENTRIES = 100;

function isSecretKey(key: string): boolean {
  return SECRET_KEY_PATTERN.test(key);
}

function shouldPreserveValue(value: string): boolean {
  return /\$\{[^}]+\}/.test(value);
}

function redactCredentialMatch(match: string): string {
  const prefix = match.startsWith('sk-') ? 'sk'
    : match.startsWith('tid=') ? 'tid'
      : match.startsWith('ghu_') ? 'ghu'
        : match.startsWith('rt_') ? 'rt'
          : match.startsWith('tok_') ? 'tok' : 'credential';
  return `${prefix}-${SECRET_REDACTION_PLACEHOLDER}`;
}

function redactCredentialLiterals(content: string): string {
  if (!content) return content;
  return content
    .replace(CREDENTIAL_LITERAL_RE, redactCredentialMatch)
    .replace(BEARER_CREDENTIAL_RE, (_match, prefix: string) => `${prefix}${SECRET_REDACTION_PLACEHOLDER}`);
}

function redactSecrets(content: string): string {
  if (!content) return content;
  return redactCredentialLiterals(redactYamlSecretValues(redactJsonSecretValues(content)));
}

function redactProviderLikeText(content: string): string {
  if (!content) return content;
  return redactInlineSecretAssignments(redactEscapedJsonSecretValues(redactSecrets(content)));
}

function redactJsonSecretValues(content: string): string {
  if (!content) return content;

  return content.replace(JSON_SECRET_VALUE_RE, (_match, keyPart, wsBefore, wsAfter, valuePart) => {
    const keyInner = keyPart.slice(1, -1);

    if (!isSecretKey(keyInner) || shouldPreserveValue(valuePart)) {
      return `${keyPart}${wsBefore}:${wsAfter}"${valuePart}"`;
    }

    return `${keyPart}${wsBefore}:${wsAfter}"${SECRET_REDACTION_PLACEHOLDER}"`;
  });
}

function redactYamlSecretValues(content: string): string {
  if (!content) return content;

  return content.replace(YAML_SECRET_VALUE_RE, (match, prefix: string, key: string, valuePart: string) => {
    const trimmed = valuePart.trim();
    if (!isSecretKey(key) || shouldPreserveValue(trimmed)) return match;
    const quote = trimmed.startsWith('"') && trimmed.endsWith('"') ? '"' : trimmed.startsWith("'") && trimmed.endsWith("'") ? "'" : '';
    return `${prefix}${quote}${SECRET_REDACTION_PLACEHOLDER}${quote}`;
  });
}

function redactEscapedJsonSecretValues(content: string): string {
  if (!content) return content;

  return content.replace(
    ESCAPED_JSON_SECRET_VALUE_RE,
    (match, keyOpen: string, key: string, keyClose: string, separator: string, valueOpen: string, secretValue: string, valueClose: string) => {
      if (!isSecretKey(key) || shouldPreserveValue(secretValue)) {
        return match;
      }
      return `${keyOpen}${key}${keyClose}${separator}${valueOpen}${SECRET_REDACTION_PLACEHOLDER}${valueClose}`;
    },
  );
}

function redactInlineSecretAssignments(content: string): string {
  if (!content) return content;
  return content
    .replace(INLINE_SECRET_ASSIGNMENT_RE, (match, key: string) => {
      if (!isSecretKey(key)) return match;
      return `${key}=${SECRET_REDACTION_PLACEHOLDER}`;
    })
    .replace(URL_SECRET_QUERY_PARAM_RE, (_match, prefix: string) => `${prefix}${SECRET_REDACTION_PLACEHOLDER}`);
}

function rawDynamicText(value: unknown, seen = new WeakSet<object>()): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (value instanceof Error) return value.message;
  if (typeof value === 'object') {
    try {
      return JSON.stringify(value, (_key, entryValue: unknown) => {
        if (typeof entryValue === 'object' && entryValue !== null) {
          if (seen.has(entryValue)) return '[Circular]';
          seen.add(entryValue);
        }
        if (entryValue instanceof Error) return entryValue.message;
        return entryValue;
      }) ?? CONVERSION_FAILURE;
    } catch {
      return CONVERSION_FAILURE;
    }
  }
  try {
    return String(value);
  } catch {
    return CONVERSION_FAILURE;
  }
}

function shouldRedactKey(key: string): boolean {
  return isSecretKey(key);
}

function redactObjectValue(value: unknown, keyHint: string | undefined, depth: number, seen: WeakSet<object>, options: StructuredRedactionOptions): unknown {
  if (typeof value === 'string') {
    return keyHint && shouldRedactKey(keyHint) ? SECRET_REDACTION_PLACEHOLDER : redactProviderLikeText(value);
  }

  if (value instanceof Error) {
    return redactProviderLikeText(value.message);
  }

  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value)) return '[Circular]';

  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
  if (depth >= maxDepth) return '[MaxDepth]';

  seen.add(value);
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;

  if (Array.isArray(value)) {
    const output = value.slice(0, maxEntries).map((entry) => redactObjectValue(entry, undefined, depth + 1, seen, options));
    if (value.length > maxEntries) output.push(`[${value.length - maxEntries} entries truncated]`);
    seen.delete(value);
    return output;
  }

  const output: Record<string, unknown> = {};
  let count = 0;
  for (const [key, entryValue] of Object.entries(value as Record<string, unknown>)) {
    if (count >= maxEntries) {
      output.__truncated__ = `${Object.keys(value as Record<string, unknown>).length - maxEntries} entries truncated`;
      break;
    }
    output[key] = shouldRedactKey(key)
      ? SECRET_REDACTION_PLACEHOLDER
      : redactObjectValue(entryValue, key, depth + 1, seen, options);
    count += 1;
  }
  seen.delete(value);
  return output;
}

export function redactForOutbound<T>(value: T, options: StructuredRedactionOptions = {}): T {
  return redactObjectValue(value, undefined, 0, new WeakSet<object>(), options) as T;
}

export function redactTextForOutbound(value: unknown): string {
  return redactProviderLikeText(rawDynamicText(value));
}

export function redactSnippetForOutbound(value: unknown, maxLength: number): string {
  return redactTextForOutbound(value).slice(0, maxLength);
}
