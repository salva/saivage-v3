import { isSecretKey } from './secret-key.js';

export const SECRET_REDACTION_PLACEHOLDER = '[REDACTED]';

const SECRET_NAME_SYNTAX =
  'credential|credentials|secret|password|token|authorization|auth|api[_-]?key|apiKey|cookie|set-cookie';
const CREDENTIAL_FAMILIES = [
  { prefix: 'sk-', body: '[^\\s"\\\\]+', label: 'sk' },
  { prefix: 'tid=', body: '[^\\s"\\\\]+', label: 'tid' },
  { prefix: 'ghu_', body: '[A-Za-z0-9_]+', label: 'ghu' },
  { prefix: 'rt_', body: '[^\\s"\\\\]+', label: 'rt' },
  { prefix: 'tok_', body: '[^\\s"\\\\]+', label: 'tok' },
  { prefix: 'ghp_', body: '[A-Za-z0-9_]+', label: 'ghp' },
  { prefix: 'github_pat_', body: '[A-Za-z0-9_]+', label: 'github_pat' },
  { prefix: 'AKIA', body: '[A-Z0-9]{16}(?![A-Za-z0-9_])', label: 'AKIA' },
  { prefix: 'xox[bpars]-', body: '[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*', label: 'xox' },
] as const;
const CREDENTIAL_LITERAL_BOUNDARY_RE = new RegExp(
  `\\b(?:${CREDENTIAL_FAMILIES.map(
    ({ prefix, body, label }) => `${label}-\\[REDACTED\\]|${prefix}${body}`,
  ).join('|')})`,
  'g',
);
const CONVERSION_FAILURE = '[unserializable dynamic value]';

// One layer of the canonical JSON string spelling used by record-context substitution.
// These fragments describe represented characters, never enclosing quoted regions.
const ENCODED_UNICODE_ESCAPE = String.raw`u(?:00(?:0[0-7be-f]|1[0-9a-f])|d[89abcdef][0-9a-f]{2})`;
const ENCODED_ESCAPE = String.raw`\\(?:["\\bfnrt]|${ENCODED_UNICODE_ESCAPE})`;
const ENCODED_FINAL_ESCAPE_RE = new RegExp(`${ENCODED_ESCAPE}$`);
const encodedUnit = (plainClass: string, escapes = ENCODED_ESCAPE): string =>
  `(?:${plainClass}|${escapes})`;
const ENCODED_UNIT = encodedUnit(String.raw`[^"\\\x00-\x1f]`);
const ENCODED_NON_LF = encodedUnit(
  String.raw`[^"\\\x00-\x1f]`,
  String.raw`\\(?:["\\bfrt]|${ENCODED_UNICODE_ESCAPE})`,
);
const ENCODED_SPACE = String.raw`(?:[^\S\x00-\x1f]|\\[fnrt]|\\u000b)`;
const ENCODED_NON_SPACE = encodedUnit(
  String.raw`[^"\\\s\x00-\x1f]`,
  String.raw`\\(?:["\\b]|u(?:00(?:0[0-7e-f]|1[0-9a-f])|d[89abcdef][0-9a-f]{2}))`,
);
const ENCODED_CREDENTIAL_VALUE = encodedUnit(
  String.raw`[^"\\\s\x00-\x1f]`,
  String.raw`\\(?:b|u(?:00(?:0[0-7e-f]|1[0-9a-f])|d[89abcdef][0-9a-f]{2}))`,
);
const ENCODED_NON_QUOTE = encodedUnit(
  String.raw`[^"\\\x00-\x1f]`,
  String.raw`\\(?:[\\bfnrt]|${ENCODED_UNICODE_ESCAPE})`,
);
const ENCODED_NON_QUOTE_OR_SLASH = encodedUnit(
  String.raw`[^"\\\x00-\x1f]`,
  String.raw`\\(?:[bfnrt]|${ENCODED_UNICODE_ESCAPE})`,
);
const ENCODED_JSON_CHARACTER = `(?:${String.raw`\\\\`}${ENCODED_UNIT}|${ENCODED_NON_QUOTE_OR_SLASH})`;
const ENCODED_JSON_STRING = `${String.raw`\\"`}${ENCODED_JSON_CHARACTER}*${String.raw`\\"`}`;
const JSON_SECRET_VALUE_RE = /("(?:[^"\\]|\\.)*")(\s*):(\s*)"((?:[^"\\]|\\.)*)"/gi;
const ENCODED_JSON_SECRET_VALUE_RE = new RegExp(
  `${ENCODED_JSON_STRING}${ENCODED_SPACE}*:${ENCODED_SPACE}*${ENCODED_JSON_STRING}`,
  'gi',
);
const YAML_SECRET_VALUE_RE =
  /(^[ \t]*([A-Za-z][A-Za-z0-9_-]*)[ \t]*:[ \t]*)([^\n#][^\n]*)(?=$|\n)/gim;
const ENCODED_YAML_SECRET_VALUE_RE = new RegExp(
  `(?: |${String.raw`\\t`})*[A-Za-z][A-Za-z0-9_-]*(?: |${String.raw`\\t`})*:(?: |${String.raw`\\t`})*(?!#)${ENCODED_NON_LF}+`,
  'gi',
);
const CREDENTIAL_LITERAL_RE = new RegExp(
  `\\b(?:${CREDENTIAL_FAMILIES.map(({ prefix, body }) => `(${prefix}(?!\\[REDACTED\\])${body})`).join('|')})\\b`,
  'g',
);
const ENCODED_CREDENTIAL_LITERAL_RE = new RegExp(
  `(?:${CREDENTIAL_FAMILIES.map(({ prefix, body }) => `(${prefix}(?!\\[REDACTED\\])${body === '[^\\s"\\\\]+' ? `${ENCODED_CREDENTIAL_VALUE}+` : body})`).join('|')})(?<=[A-Za-z0-9_])(?<!${ENCODED_ESCAPE})(?![A-Za-z0-9_])`,
  'g',
);
const BEARER_CREDENTIAL_RE = /\b(Bearer\s+)([^\s"\\]+)/gi;
const ENCODED_BEARER_CREDENTIAL_RE = new RegExp(
  `Bearer${ENCODED_SPACE}+${ENCODED_CREDENTIAL_VALUE}+`,
  'gi',
);
const ESCAPED_JSON_SECRET_VALUE_RE = /(\\")([^"\\]+)(\\")(\s*:\s*)(\\")([^"\\]*)(\\")/gi;
const ENCODED_ESCAPED_JSON_SECRET_VALUE_RE = new RegExp(
  `${String.raw`\\\\\\"`}${ENCODED_NON_QUOTE_OR_SLASH}+${String.raw`\\\\\\"`}${ENCODED_SPACE}*:${ENCODED_SPACE}*${String.raw`\\\\\\"`}${ENCODED_NON_QUOTE_OR_SLASH}*${String.raw`\\\\\\"`}`,
  'gi',
);
const INLINE_SECRET_ASSIGNMENT_RE = new RegExp(
  String.raw`\b([A-Za-z][A-Za-z0-9_-]*(?:(?:${SECRET_NAME_SYNTAX})[A-Za-z0-9_-]*)?)\s*=\s*("[^"]*"|'[^']*'|\S+)`,
  'gi',
);
const ENCODED_INLINE_SECRET_ASSIGNMENT_RE = new RegExp(
  `([A-Za-z][A-Za-z0-9_-]*)${ENCODED_SPACE}*=${ENCODED_SPACE}*(${String.raw`\\"`}${ENCODED_NON_QUOTE}*${String.raw`\\"`}|'${encodedUnit(String.raw`[^'"\\\x00-\x1f]`)}*'|${ENCODED_NON_SPACE}+)`,
  'gi',
);
const COMPLETE_INLINE_DOUBLE_QUOTED_VALUE_RE = /^"(?:[^"\\]|\\[\s\S])*"/;
const COMPLETE_ENCODED_INLINE_VALUE_RE = new RegExp(`^${ENCODED_JSON_STRING}`);
const URL_SECRET_QUERY_PARAM_RE = new RegExp(
  String.raw`([?&][^=&#\s]*(?:${SECRET_NAME_SYNTAX})[^=&#\s]*=)([^&#\s]+)`,
  'gi',
);
const ENCODED_URL_SECRET_QUERY_PARAM_RE = new RegExp(
  `[?&](?:(?![=&#])${ENCODED_NON_SPACE})*(?:${SECRET_NAME_SYNTAX})(?:(?![=&#])${ENCODED_NON_SPACE})*=(?:(?![&#])${ENCODED_NON_SPACE})+`,
  'gi',
);

function isEncodedUnitStart(text: string, offset: number): boolean {
  let slashes = 0;
  for (let i = offset - 1; i >= 0 && text[i] === '\\'; i--) slashes++;
  return slashes % 2 === 0;
}

function representedPreviousCharacter(text: string, offset: number): string {
  const prefix = text.slice(0, offset);
  const escape = ENCODED_FINAL_ESCAPE_RE.exec(prefix);
  return escape && isEncodedUnitStart(text, offset - escape[0].length)
    ? (JSON.parse(`"${escape[0]}"`) as string)
    : prefix.slice(-1);
}

function hasRepresentedWordBoundary(text: string, offset: number, next: string): boolean {
  return /\w/.test(representedPreviousCharacter(text, offset)) !== /\w/.test(next);
}

function atEncodedUnitStart(pattern: RegExp): RegExp {
  return new RegExp(`${String.raw`(?<!(?<!\\)(?:\\\\)*\\)`}${pattern.source}`, pattern.flags);
}

function replaceEncodedPattern(
  text: string,
  pattern: RegExp,
  ordinary: RegExp,
  replacement: Replacement,
  boundary: 'none' | 'word' | 'credential' | 'yaml' = 'none',
): string {
  // Exclude starts inside an escape before matching, so a rejected candidate cannot
  // swallow a later legitimate start (for example the key after encoded tab).
  const atUnitStart = atEncodedUnitStart(pattern);
  return text.replace(atUnitStart, (match: string, ...args: unknown[]) => {
    const offset = args.at(-2) as number;
    if (boundary === 'yaml') {
      const previous = text[offset - 1];
      if (
        offset !== 0 &&
        previous !== '"' &&
        previous !== '\n' &&
        representedPreviousCharacter(text, offset) !== '\n'
      )
        return match;
    } else if (boundary !== 'none') {
      if (!hasRepresentedWordBoundary(text, offset, match[0]!)) return match;
      if (
        boundary === 'credential' &&
        !hasRepresentedWordBoundary(text, offset + match.length, text[offset + match.length] ?? '')
      )
        return match;
    }
    const decoded = JSON.parse(`"${match}"`) as string;
    const changed = decoded.replace(cloneRegex(ordinary), replacement);
    return changed === decoded ? match : JSON.stringify(changed).slice(1, -1);
  });
}

function redactEncodedInlineAssignments(text: string): string {
  const matcher = atEncodedUnitStart(ENCODED_INLINE_SECRET_ASSIGNMENT_RE);
  const parts: string[] = [];
  let end = 0;
  for (let match; (match = matcher.exec(text)) !== null; ) {
    parts.push(text.slice(end, match.index));
    let chosen = match[0];
    const key = match[1]!;
    const value = match[2]!;
    if (
      hasRepresentedWordBoundary(text, match.index, chosen[0]!) &&
      isSecretKey(key) &&
      !value.startsWith(SECRET_REDACTION_PLACEHOLDER)
    ) {
      if (value.startsWith(String.raw`\"`)) {
        const valueStart = matcher.lastIndex - value.length;
        const complete = COMPLETE_ENCODED_INLINE_VALUE_RE.exec(text.slice(valueStart));
        if (complete && complete[0].length > value.length)
          chosen = text.slice(match.index, valueStart + complete[0].length);
      }
      const selected = JSON.parse(`"${chosen}"`) as string;
      const changed = redactInlineAssignments(selected);
      // Only a changed (masked) candidate may consume an extended range.
      if (changed !== selected) {
        matcher.lastIndex = match.index + chosen.length;
        chosen = JSON.stringify(changed).slice(1, -1);
      } else chosen = match[0];
    }
    parts.push(chosen);
    end = matcher.lastIndex;
  }
  parts.push(text.slice(end));
  return parts.join('');
}

/** Filter one supplier JSON-string layer for record-prompt preparation/public projection. */
export function redactRecordPromptForOutbound(text: string): string {
  let result = replaceEncodedPattern(
    text,
    ENCODED_JSON_SECRET_VALUE_RE,
    JSON_SECRET_VALUE_RE,
    replaceJsonSecretValue,
  );
  result = replaceEncodedPattern(
    result,
    ENCODED_YAML_SECRET_VALUE_RE,
    YAML_SECRET_VALUE_RE,
    replaceYamlSecretValue,
    'yaml',
  );
  result = replaceEncodedPattern(
    result,
    ENCODED_CREDENTIAL_LITERAL_RE,
    CREDENTIAL_LITERAL_RE,
    redactCredentialMatch,
    'credential',
  );
  result = replaceEncodedPattern(
    result,
    ENCODED_BEARER_CREDENTIAL_RE,
    BEARER_CREDENTIAL_RE,
    replaceBearerCredential,
    'word',
  );
  result = replaceEncodedPattern(
    result,
    ENCODED_ESCAPED_JSON_SECRET_VALUE_RE,
    ESCAPED_JSON_SECRET_VALUE_RE,
    replaceEscapedJsonSecretValue,
  );
  result = redactEncodedInlineAssignments(result);
  result = replaceEncodedPattern(
    result,
    ENCODED_URL_SECRET_QUERY_PARAM_RE,
    URL_SECRET_QUERY_PARAM_RE,
    replaceUrlSecretQueryParam,
  );
  return redactTextForOutbound(result);
}

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
      if (typeof offset !== 'number')
        throw new Error('Text redaction match did not provide an offset.');
      const end = offset + match.length;
      spans.push({ start: offset, end });
      if (rule.replacement(match, ...captures) !== match)
        maxPrefixEnd = Math.min(maxPrefixEnd, offset);
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
function redactCredentialMatch(_match: string, ...captures: unknown[]): string {
  const index = captures
    .slice(0, CREDENTIAL_FAMILIES.length)
    .findIndex((capture) => typeof capture === 'string');
  const family = CREDENTIAL_FAMILIES[index];
  if (!family) throw new Error('Credential match did not identify a family.');
  return `${family.label}-${SECRET_REDACTION_PLACEHOLDER}`;
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
  const quote =
    trimmed.startsWith('"') && trimmed.endsWith('"')
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
  const [keyOpen, key, keyClose, separator, valueOpen, secretValue, valueClose] = captures as [
    string,
    string,
    string,
    string,
    string,
    string,
    string,
  ];
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
    .replace(CREDENTIAL_LITERAL_RE, redactCredentialMatch)
    .replace(BEARER_CREDENTIAL_RE, replaceBearerCredential);
}
function redactSecrets(content: string): string {
  return content
    ? redactCredentialLiterals(redactYamlSecretValues(redactJsonSecretValues(content)))
    : content;
}
function redactProviderLikeText(content: string): string {
  return content
    ? redactSecretAssignmentsForOutbound(redactEscapedJsonSecretValues(redactSecrets(content)))
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
export function redactSecretAssignmentsForOutbound(content: string): string {
  return redactInlineAssignments(content).replace(
    URL_SECRET_QUERY_PARAM_RE,
    replaceUrlSecretQueryParam,
  );
}
function redactInlineAssignments(content: string): string {
  const matcher = cloneRegex(INLINE_SECRET_ASSIGNMENT_RE);
  const parts: string[] = [];
  let end = 0;
  for (let match; (match = matcher.exec(content)) !== null; ) {
    parts.push(content.slice(end, match.index));
    const key = match[1]!;
    const value = match[2]!;
    if (isSecretKey(key) && !value.startsWith(SECRET_REDACTION_PLACEHOLDER)) {
      if (value.startsWith('"')) {
        const valueStart = matcher.lastIndex - value.length;
        const complete = COMPLETE_INLINE_DOUBLE_QUOTED_VALUE_RE.exec(content.slice(valueStart));
        if (complete && complete[0].length > value.length)
          matcher.lastIndex = valueStart + complete[0].length;
      }
      parts.push(`${key}=${SECRET_REDACTION_PLACEHOLDER}`);
    } else parts.push(match[0]);
    end = matcher.lastIndex;
  }
  parts.push(content.slice(end));
  return parts.join('');
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
