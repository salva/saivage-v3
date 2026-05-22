import {
  SECRET_REDACTION_PLACEHOLDER,
  isSecretKey,
  redactProviderLikeText,
} from './secret-redaction.js';

export type RedactionSink =
  | 'console'
  | 'model_issue'
  | 'observability'
  | 'notification'
  | 'provider_diagnostic'
  | 'telegram_diagnostic';

export interface RedactionContext {
  sink: RedactionSink;
  source: string;
  maxLength?: number;
  maxDepth?: number;
  maxEntries?: number;
}

const CONVERSION_FAILURE = '[unserializable dynamic value]';
const DEFAULT_SNIPPET_LENGTH = 500;
const DEFAULT_MAX_DEPTH = 8;
const DEFAULT_MAX_ENTRIES = 100;
const TELEGRAM_BOT_PATH_RE = /(\/bot)([^/\s?#]+)(?=\/)/gi;

function redactTelegramBotPath(content: string): string {
  if (!content) return content;
  return content.replace(TELEGRAM_BOT_PATH_RE, (_match, prefix: string) => `${prefix}${SECRET_REDACTION_PLACEHOLDER}`);
}

function redactTextContent(content: string): string {
  return redactTelegramBotPath(redactProviderLikeText(content));
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

function isRuntimeActivationLedgerIdempotencyKey(context: RedactionContext, path: readonly string[], root: unknown): boolean {
  if (context.sink !== 'observability') return false;
  if (path.length !== 2 || path[0] !== 'activation' || path[1] !== 'idempotency_key') return false;
  if (root === null || typeof root !== 'object') return false;
  return (root as Record<string, unknown>).kind === 'runtime_activation';
}

function shouldRedactKey(key: string, context: RedactionContext, path: readonly string[], root: unknown): boolean {
  if (key === 'idempotency_key' && isRuntimeActivationLedgerIdempotencyKey(context, path, root)) return false;
  return isSecretKey(key);
}

function redactObjectValue(value: unknown, context: RedactionContext, keyHint: string | undefined, depth: number, seen: WeakSet<object>, path: readonly string[], root: unknown): unknown {
  if (typeof value === 'string') {
    return keyHint && shouldRedactKey(keyHint, context, path, root) ? SECRET_REDACTION_PLACEHOLDER : redactTextContent(value);
  }

  if (value instanceof Error) {
    return redactTextContent(value.message);
  }

  if (value === null || typeof value !== 'object') return value;

  if (seen.has(value)) return '[Circular]';

  const maxDepth = context.maxDepth ?? DEFAULT_MAX_DEPTH;
  if (depth >= maxDepth) return '[MaxDepth]';

  seen.add(value);
  const maxEntries = context.maxEntries ?? DEFAULT_MAX_ENTRIES;

  if (Array.isArray(value)) {
    const output = value.slice(0, maxEntries).map((entry) => redactObjectValue(entry, context, undefined, depth + 1, seen, path, root));
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
    const entryPath = [...path, key];
    output[key] = shouldRedactKey(key, context, entryPath, root)
      ? SECRET_REDACTION_PLACEHOLDER
      : redactObjectValue(entryValue, context, key, depth + 1, seen, entryPath, root);
    count += 1;
  }
  seen.delete(value);
  return output;
}

export const RedactionBoundary = {
  text(value: unknown, context: RedactionContext): string {
    void context;
    return redactTextContent(rawDynamicText(value));
  },

  error(error: unknown, context: RedactionContext): string {
    return this.text(error, context);
  },

  object<T>(value: T, context: RedactionContext): T {
    return redactObjectValue(value, context, undefined, 0, new WeakSet<object>(), [], value) as T;
  },

  url(value: string, context: RedactionContext): string {
    return this.text(value, context);
  },

  snippet(value: unknown, context: RedactionContext): string {
    const maxLength = context.maxLength ?? DEFAULT_SNIPPET_LENGTH;
    return this.text(value, context).slice(0, maxLength);
  },
};
