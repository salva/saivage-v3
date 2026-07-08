export const SECRET_REDACTION_PLACEHOLDER = '[REDACTED]';

declare const redactedBrand: unique symbol;
declare const secretBrand: unique symbol;

export type Redacted<T> = T & { readonly [redactedBrand]: true };
export type Secret<T> = T & { readonly [secretBrand]: true } & { reveal(): T; toJSON(): '[redacted]' };

export type RedactionPolicyName =
  | 'observability.log'
  | 'error.log'
  | 'provider.diagnostic'
  | 'provider.message'
  | 'operator.websocket'
  | 'operator.api'
  | 'notification.transport'
  | 'telegram.diagnostic'
  | 'model.issue'
  | `event:${string}`;

export interface RedactionContext {
  policy: RedactionPolicyName;
  source: string;
  maxLength?: number;
  maxDepth?: number;
  maxEntries?: number;
}

export interface RedactionPolicy {
  readonly name: RedactionPolicyName;
  readonly maxDepth?: number;
  readonly maxEntries?: number;
}

export interface RedactionPort {
  policies(): RedactionPolicyName[];
  policy(name: RedactionPolicyName): RedactionPolicy;
  redact<T>(value: T, policy: RedactionPolicyName, options?: RedactionOptions): Redacted<T>;
  redactText(value: unknown, policy: RedactionPolicyName, options?: RedactionOptions): Redacted<string>;
  snippet(value: unknown, policy: RedactionPolicyName, maxLength: number, options?: RedactionOptions): Redacted<string>;
  forKind<K extends string>(kind: K): <T>(payload: T) => Redacted<T>;
}

export interface RedactionOptions {
  source?: string;
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
const TELEGRAM_BOT_PATH_RE = /(\/bot)([^/\s?#]+)(?=\/)/gi;

const CONVERSION_FAILURE = '[unserializable dynamic value]';
const DEFAULT_SNIPPET_LENGTH = 500;
const DEFAULT_MAX_DEPTH = 8;
const DEFAULT_MAX_ENTRIES = 100;

const POLICIES: ReadonlyMap<RedactionPolicyName, RedactionPolicy> = new Map<RedactionPolicyName, RedactionPolicy>([
  ['observability.log', { name: 'observability.log' }],
  ['error.log', { name: 'error.log' }],
  ['provider.diagnostic', { name: 'provider.diagnostic' }],
  ['provider.message', { name: 'provider.message' }],
  ['operator.websocket', { name: 'operator.websocket' }],
  ['operator.api', { name: 'operator.api' }],
  ['notification.transport', { name: 'notification.transport' }],
  ['telegram.diagnostic', { name: 'telegram.diagnostic' }],
  ['model.issue', { name: 'model.issue' }],
]);

function brandRedacted<T>(value: T): Redacted<T> {
  return value as Redacted<T>;
}

export function makeSecret<T>(value: T): Secret<T> {
  return {
    reveal: () => value,
    toJSON: () => '[redacted]' as const,
  } as Secret<T>;
}

export function revealSecret<T>(secret: Secret<T>): T {
  return secret.reveal();
}

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
  return redactTelegramBotTokenPath(redactInlineSecretAssignments(redactEscapedJsonSecretValues(redactSecrets(content))));
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

function redactTelegramBotTokenPath(content: string): string {
  if (!content) return content;
  return content.replace(TELEGRAM_BOT_PATH_RE, (_match, prefix: string) => `${prefix}${SECRET_REDACTION_PLACEHOLDER}`);
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

function redactObjectValue(value: unknown, policy: RedactionPolicy, keyHint: string | undefined, depth: number, seen: WeakSet<object>, options: RedactionOptions): unknown {
  if (typeof value === 'string') {
    return keyHint && shouldRedactKey(keyHint) ? SECRET_REDACTION_PLACEHOLDER : redactProviderLikeText(value);
  }

  if (value instanceof Error) {
    return redactProviderLikeText(value.message);
  }

  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value)) return '[Circular]';

  const maxDepth = options.maxDepth ?? policy.maxDepth ?? DEFAULT_MAX_DEPTH;
  if (depth >= maxDepth) return '[MaxDepth]';

  seen.add(value);
  const maxEntries = options.maxEntries ?? policy.maxEntries ?? DEFAULT_MAX_ENTRIES;

  if (Array.isArray(value)) {
    const output = value.slice(0, maxEntries).map((entry) => redactObjectValue(entry, policy, undefined, depth + 1, seen, options));
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
      : redactObjectValue(entryValue, policy, key, depth + 1, seen, options);
    count += 1;
  }
  seen.delete(value);
  return output;
}

function requirePolicy(name: RedactionPolicyName): RedactionPolicy {
  const eventPolicy = name.startsWith('event:') ? { name } : undefined;
  const policy = POLICIES.get(name) ?? eventPolicy;
  if (!policy) {
    throw new Error(`Unknown redaction policy '${name}'`);
  }
  return policy;
}

export const redactionPort: RedactionPort = {
  policies(): RedactionPolicyName[] {
    return [...POLICIES.keys()];
  },

  policy(name: RedactionPolicyName): RedactionPolicy {
    return requirePolicy(name);
  },

  redact<T>(value: T, policyName: RedactionPolicyName, options: RedactionOptions = {}): Redacted<T> {
    const policy = requirePolicy(policyName);
    return brandRedacted(redactObjectValue(value, policy, undefined, 0, new WeakSet<object>(), options) as T);
  },

  redactText(value: unknown, policyName: RedactionPolicyName): Redacted<string> {
    requirePolicy(policyName);
    return brandRedacted(redactProviderLikeText(rawDynamicText(value)));
  },

  snippet(value: unknown, policyName: RedactionPolicyName, maxLength = DEFAULT_SNIPPET_LENGTH): Redacted<string> {
    return brandRedacted(redactionPort.redactText(value, policyName).slice(0, maxLength));
  },

  forKind<K extends string>(kind: K): <T>(payload: T) => Redacted<T> {
    return <T>(payload: T) => redactionPort.redact(payload, `event:${kind}`);
  },
};

export function redactForOutbound<T>(value: T, policy: RedactionPolicyName, options?: RedactionOptions): Redacted<T> {
  return redactionPort.redact(value, policy, options);
}

export function redactTextForOutbound(value: unknown, policy: RedactionPolicyName, options?: RedactionOptions): Redacted<string> {
  void options;
  return redactionPort.redactText(value, policy);
}

export function redactSnippetForOutbound(value: unknown, policy: RedactionPolicyName, maxLength: number, options?: RedactionOptions): Redacted<string> {
  void options;
  return redactionPort.snippet(value, policy, maxLength);
}
