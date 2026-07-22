export const SECRET_REDACTION_PLACEHOLDER = '[REDACTED]';

const SECRET_KEY_PATTERN =
  /\b(?:apiKey|apiToken|botToken|accessToken|refreshToken|(?:api_)?key|token|authorization|.*[A-Z](?:Token|Key|Secret|Password)|.*_(?:key|token|secret|password)|secret|password|credential|credentials?|cookie|set-cookie|auth)\b/i;
const JSON_SECRET_VALUE_RE = /("(?:[^"\\]|\\.)*")(\s*):(\s*)"((?:[^"\\]|\\.)*)"/gi;
const YAML_SECRET_VALUE_RE = /(^[ \t]*([A-Za-z][A-Za-z0-9_-]*)[ \t]*:[ \t]*)([^\n#][^\n]*)(?=$|\n)/gmi;
const ESCAPED_JSON_SECRET_VALUE_RE = /(\\")([^"\\]+)(\\")(\s*:\s*)(\\")([^"\\]*)(\\")/gi;
const INLINE_SECRET_ASSIGNMENT_RE = /\b([A-Za-z][A-Za-z0-9_-]*(?:(?:credential|credentials|secret|password|token|authorization|auth|api[_-]?key|apiKey|cookie|set-cookie)[A-Za-z0-9_-]*)?)\s*=\s*("[^"]*"|'[^']*'|\S+)/gi;
const CREDENTIAL_LITERAL_RE = /\b(sk-(?!\[REDACTED\])[^\s"\\]+|tid=(?!\[REDACTED\])[^\s"\\]+|ghu_(?!\[REDACTED\])[A-Za-z0-9_]+|rt_(?!\[REDACTED\])[^\s"\\]+|tok_(?!\[REDACTED\])[^\s"\\]+)\b/g;
const BEARER_CREDENTIAL_RE = /\b(Bearer\s+)([^\s"\\]+)/gi;
const URL_SECRET_QUERY_PARAM_RE = /([?&][^=&#\s]*(?:credential|credentials|secret|password|token|authorization|auth|api[_-]?key|apiKey|cookie|set-cookie)[^=&#\s]*=)([^&#\s]+)/gi;
const CONVERSION_FAILURE = '[unserializable dynamic value]';

export function redactTextForOutbound(value: unknown): string {
  return redactProviderLikeText(rawDynamicText(value));
}

export function redactSnippetForOutbound(value: unknown, maxLength: number): string {
  return redactTextForOutbound(value).slice(0, maxLength);
}

export function redactUrl(raw: string): string {
  try {
    const url = new URL(raw);
    url.username = url.username ? SECRET_REDACTION_PLACEHOLDER : '';
    url.password = url.password ? SECRET_REDACTION_PLACEHOLDER : '';
    url.search = url.search ? `?${SECRET_REDACTION_PLACEHOLDER}` : '';
    url.hash = '';
    return url.toString();
  } catch {
    return '[INVALID_URL]';
  }
}

function isSecretKey(key: string): boolean { return SECRET_KEY_PATTERN.test(key); }
function shouldPreserveValue(value: string): boolean { return /\$\{[^}]+\}/.test(value); }
function redactCredentialMatch(match: string): string {
  const prefix = match.startsWith('sk-') ? 'sk' : match.startsWith('tid=') ? 'tid' : match.startsWith('ghu_') ? 'ghu' : match.startsWith('rt_') ? 'rt' : match.startsWith('tok_') ? 'tok' : 'credential';
  return `${prefix}-${SECRET_REDACTION_PLACEHOLDER}`;
}
function redactCredentialLiterals(content: string): string {
  return content ? content.replace(CREDENTIAL_LITERAL_RE, redactCredentialMatch).replace(BEARER_CREDENTIAL_RE, (_match, prefix: string) => `${prefix}${SECRET_REDACTION_PLACEHOLDER}`) : content;
}
function redactSecrets(content: string): string { return content ? redactCredentialLiterals(redactYamlSecretValues(redactJsonSecretValues(content))) : content; }
function redactProviderLikeText(content: string): string { return content ? redactInlineSecretAssignments(redactEscapedJsonSecretValues(redactSecrets(content))) : content; }
function redactJsonSecretValues(content: string): string {
  return content.replace(JSON_SECRET_VALUE_RE, (_match, keyPart, wsBefore, wsAfter, valuePart) => {
    const keyInner = keyPart.slice(1, -1);
    return !isSecretKey(keyInner) || shouldPreserveValue(valuePart) ? `${keyPart}${wsBefore}:${wsAfter}"${valuePart}"` : `${keyPart}${wsBefore}:${wsAfter}"${SECRET_REDACTION_PLACEHOLDER}"`;
  });
}
function redactYamlSecretValues(content: string): string {
  return content.replace(YAML_SECRET_VALUE_RE, (match, prefix: string, key: string, valuePart: string) => {
    const trimmed = valuePart.trim();
    if (!isSecretKey(key) || shouldPreserveValue(trimmed)) return match;
    const quote = trimmed.startsWith('"') && trimmed.endsWith('"') ? '"' : trimmed.startsWith("'") && trimmed.endsWith("'") ? "'" : '';
    return `${prefix}${quote}${SECRET_REDACTION_PLACEHOLDER}${quote}`;
  });
}
function redactEscapedJsonSecretValues(content: string): string {
  return content.replace(ESCAPED_JSON_SECRET_VALUE_RE, (match, keyOpen: string, key: string, keyClose: string, separator: string, valueOpen: string, secretValue: string, valueClose: string) =>
    !isSecretKey(key) || shouldPreserveValue(secretValue) ? match : `${keyOpen}${key}${keyClose}${separator}${valueOpen}${SECRET_REDACTION_PLACEHOLDER}${valueClose}`);
}
function redactInlineSecretAssignments(content: string): string {
  return content.replace(INLINE_SECRET_ASSIGNMENT_RE, (match, key: string) => isSecretKey(key) ? `${key}=${SECRET_REDACTION_PLACEHOLDER}` : match)
    .replace(URL_SECRET_QUERY_PARAM_RE, (_match, prefix: string) => `${prefix}${SECRET_REDACTION_PLACEHOLDER}`);
}
function rawDynamicText(value: unknown, seen = new WeakSet<object>()): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (value instanceof Error) return value.message;
  if (typeof value === 'object') {
    try {
      return JSON.stringify(value, (_key, entryValue: unknown) => {
        if (typeof entryValue === 'object' && entryValue !== null) { if (seen.has(entryValue)) return '[Circular]'; seen.add(entryValue); }
        if (entryValue instanceof Error) return entryValue.message;
        return entryValue;
      }) ?? CONVERSION_FAILURE;
    } catch { return CONVERSION_FAILURE; }
  }
  try { return String(value); } catch { return CONVERSION_FAILURE; }
}
