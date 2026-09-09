import { isSecretKey } from './secret-key.js';

export const SECRET_REDACTION_PLACEHOLDER = '[REDACTED]';

const JSON_SECRET_VALUE_RE = /("(?:[^"\\]|\\.)*")(\s*):(\s*)"((?:[^"\\]|\\.)*)"/gi;
const YAML_SECRET_VALUE_RE =
  /(^[ \t]*([A-Za-z][A-Za-z0-9_-]*)[ \t]*:[ \t]*)([^\n#][^\n]*)(?=$|\n)/gim;
const ESCAPED_JSON_SECRET_VALUE_RE = /(\\")([^"\\]+)(\\")(\s*:\s*)(\\")([^"\\]*)(\\")/gi;
const INLINE_SECRET_ASSIGNMENT_RE =
  /\b([A-Za-z][A-Za-z0-9_-]*(?:(?:credential|credentials|secret|password|token|authorization|auth|api[_-]?key|apiKey|cookie|set-cookie)[A-Za-z0-9_-]*)?)\s*=\s*("[^"]*"|'[^']*'|\S+)/gi;
const CREDENTIAL_LITERAL_RE =
  /\b(sk-(?!\[REDACTED\])[^\s"\\]+|tid=(?!\[REDACTED\])[^\s"\\]+|ghu_(?!\[REDACTED\])[A-Za-z0-9_]+|rt_(?!\[REDACTED\])[^\s"\\]+|tok_(?!\[REDACTED\])[^\s"\\]+)\b/g;
const BEARER_CREDENTIAL_RE = /\b(Bearer\s+)([^\s"\\]+)/gi;
const URL_SECRET_QUERY_PARAM_RE =
  /([?&][^=&#\s]*(?:credential|credentials|secret|password|token|authorization|auth|api[_-]?key|apiKey|cookie|set-cookie)[^=&#\s]*=)([^&#\s]+)/gi;
const CREDENTIAL_LITERAL_BOUNDARY_RE =
  /\b(sk-[^\s"\\]+|tid=[^\s"\\]+|ghu_[A-Za-z0-9_]+|rt_[^\s"\\]+|tok_[^\s"\\]+)/g;
const CONVERSION_FAILURE = '[unserializable dynamic value]';

type Replacement = (match: string, ...captures: unknown[]) => string;

interface TextRedactionRule {
  readonly pattern: RegExp;
  readonly replacement: Replacement;
}

export function redactTextForOutbound(value: unknown): string {
  return redactProviderLikeText(rawDynamicText(value));
}

export function redactTextWithStablePrefixesForOutbound(text: string): {
  text: string;
  maxPrefixEnd: number;
  indivisibleSpans: readonly { start: number; end: number }[];
} {
  const redacted = redactProviderLikeText(text);
  let maxPrefixEnd = redacted.length;
  const spans: Array<{ start: number; end: number }> = [];

  for (const rule of TEXT_REDACTION_RULES) {
    redacted.replace(cloneRegex(rule.pattern), (match, ...captures: unknown[]) => {
      const offset = captures.at(-2);
      if (typeof offset !== 'number') throw new Error('Text redaction match did not provide an offset.');
      const end = offset + match.length;
      spans.push({ start: offset, end });
      if (rule.replacement(match, ...captures) !== match) maxPrefixEnd = Math.min(maxPrefixEnd, offset);
      return match;
    });
  }
  for (const match of redacted.matchAll(cloneRegex(CREDENTIAL_LITERAL_BOUNDARY_RE))) {
    const start = match.index;
    spans.push({ start, end: start + match[0].length });
  }

  const relevant = spans
    .filter(({ start }) => start < maxPrefixEnd)
    .map(({ start, end }) => ({ start, end }))
    .sort((left, right) => left.start - right.start || left.end - right.end);
  const merged: Array<{ start: number; end: number }> = [];
  for (const span of relevant) {
    const previous = merged.at(-1);
    if (previous && span.start < previous.end) previous.end = Math.max(previous.end, span.end);
    else merged.push(span);
  }
  return { text: redacted, maxPrefixEnd, indivisibleSpans: merged };
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

function shouldPreserveValue(value: string): boolean {
  return /^\s*(\$\{[^}]+\}\s*)+$/.test(value);
}
function redactCredentialMatch(match: string): string {
  const prefix = match.startsWith('sk-')
    ? 'sk'
    : match.startsWith('tid=')
      ? 'tid'
      : match.startsWith('ghu_')
        ? 'ghu'
        : match.startsWith('rt_')
          ? 'rt'
          : match.startsWith('tok_')
            ? 'tok'
            : 'credential';
  return `${prefix}-${SECRET_REDACTION_PLACEHOLDER}`;
}
function replaceJsonSecretValue(match: string, ...captures: unknown[]): string {
  const [keyPart, wsBefore, wsAfter, valuePart] = captures as [string, string, string, string];
  const keyInner = keyPart.slice(1, -1);
  return !isSecretKey(keyInner) || shouldPreserveValue(valuePart)
    ? `${keyPart}${wsBefore}:${wsAfter}"${valuePart}"`
    : `${keyPart}${wsBefore}:${wsAfter}"${SECRET_REDACTION_PLACEHOLDER}"`;
}
function replaceYamlSecretValue(match: string, ...captures: unknown[]): string {
  const [prefix, key, valuePart] = captures as [string, string, string];
  const trimmed = valuePart.trim();
  const quote = trimmed.startsWith('"') && trimmed.endsWith('"')
    ? '"'
    : trimmed.startsWith("'") && trimmed.endsWith("'")
      ? "'"
      : '';
  const candidate = quote ? trimmed.slice(1, -1) : trimmed;
  return !isSecretKey(key) || shouldPreserveValue(candidate)
    ? match
    : `${prefix}${quote}${SECRET_REDACTION_PLACEHOLDER}${quote}`;
}
function replaceBearerCredential(_match: string, ...captures: unknown[]): string {
  return `${String(captures[0])}${SECRET_REDACTION_PLACEHOLDER}`;
}
function replaceEscapedJsonSecretValue(match: string, ...captures: unknown[]): string {
  const [keyOpen, key, keyClose, separator, valueOpen, secretValue, valueClose] = captures as [string, string, string, string, string, string, string];
  return !isSecretKey(key) || shouldPreserveValue(secretValue)
    ? match
    : `${keyOpen}${key}${keyClose}${separator}${valueOpen}${SECRET_REDACTION_PLACEHOLDER}${valueClose}`;
}
function replaceInlineSecretAssignment(match: string, ...captures: unknown[]): string {
  const [key, value] = captures as [string, string];
  return isSecretKey(key) && !value.startsWith(SECRET_REDACTION_PLACEHOLDER)
    ? `${key}=${SECRET_REDACTION_PLACEHOLDER}`
    : match;
}
function replaceUrlSecretQueryParam(match: string, ...captures: unknown[]): string {
  const [prefix, value] = captures as [string, string];
  return value.startsWith(SECRET_REDACTION_PLACEHOLDER)
    ? match
    : `${prefix}${SECRET_REDACTION_PLACEHOLDER}`;
}
function cloneRegex(pattern: RegExp): RegExp {
  return new RegExp(pattern.source, pattern.flags);
}

const TEXT_REDACTION_RULES: readonly TextRedactionRule[] = Object.freeze([
  { pattern: JSON_SECRET_VALUE_RE, replacement: replaceJsonSecretValue },
  { pattern: YAML_SECRET_VALUE_RE, replacement: replaceYamlSecretValue },
  { pattern: CREDENTIAL_LITERAL_RE, replacement: redactCredentialMatch },
  { pattern: BEARER_CREDENTIAL_RE, replacement: replaceBearerCredential },
  { pattern: ESCAPED_JSON_SECRET_VALUE_RE, replacement: replaceEscapedJsonSecretValue },
  { pattern: INLINE_SECRET_ASSIGNMENT_RE, replacement: replaceInlineSecretAssignment },
  { pattern: URL_SECRET_QUERY_PARAM_RE, replacement: replaceUrlSecretQueryParam },
]);

function redactCredentialLiterals(content: string): string {
  return content
    ? content
        .replace(CREDENTIAL_LITERAL_RE, redactCredentialMatch)
        .replace(BEARER_CREDENTIAL_RE, replaceBearerCredential)
    : content;
}
function redactSecrets(content: string): string {
  return content
    ? redactCredentialLiterals(redactYamlSecretValues(redactJsonSecretValues(content)))
    : content;
}
function redactProviderLikeText(content: string): string {
  return content
    ? redactInlineSecretAssignments(redactEscapedJsonSecretValues(redactSecrets(content)))
    : content;
}
function redactJsonSecretValues(content: string): string {
  return content.replace(JSON_SECRET_VALUE_RE, replaceJsonSecretValue);
}
function redactYamlSecretValues(content: string): string {
  return content.replace(YAML_SECRET_VALUE_RE, replaceYamlSecretValue);
}
function redactEscapedJsonSecretValues(content: string): string {
  return content.replace(ESCAPED_JSON_SECRET_VALUE_RE, replaceEscapedJsonSecretValue);
}
function redactInlineSecretAssignments(content: string): string {
  return content
    .replace(INLINE_SECRET_ASSIGNMENT_RE, replaceInlineSecretAssignment)
    .replace(URL_SECRET_QUERY_PARAM_RE, replaceUrlSecretQueryParam);
}
function rawDynamicText(value: unknown, seen = new WeakSet<object>()): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (value instanceof Error) return value.message;
  if (typeof value === 'object') {
    try {
      return (
        JSON.stringify(value, (_key, entryValue: unknown) => {
          if (typeof entryValue === 'object' && entryValue !== null) {
            if (seen.has(entryValue)) return '[Circular]';
            seen.add(entryValue);
          }
          if (entryValue instanceof Error) return entryValue.message;
          return entryValue;
        }) ?? CONVERSION_FAILURE
      );
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
