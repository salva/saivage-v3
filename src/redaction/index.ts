import type { ProviderExchangePayload } from '../contracts/provider-exchange.js';
import type { LoggedEvent, ControlActionAuditEntry, CardHistoryEntry, CardHistoryHeader } from '../schemas/index.js';
import type { OperatorCard, RuntimeCardRunsResponse } from '../contracts/index.js';
import type { CardDiffEntry } from '../cards/card-service.js';
import { projectProviderExchange } from '../agents/provider-exchange-outbound.js';
import { projectLoggedEvent } from '../observability/logged-event-projection.js';
import { projectControlAction } from '../persistence/control-action-outbound.js';
import { projectDynamicForOutbound } from './dynamic.js';
import { redactTextForOutbound } from './text.js';
import { projectCardDiff, projectCardHistory, projectOperatorCard, projectRuntimeCardRuns } from '../application/read-models/card-outbound.js';
import type { SaivageConfig } from '../agents/config-api.js';
import { projectEffectiveConfigForOutbound } from '../config/effective-config-outbound.js';
import type { ProcessOutboundValue } from '../application/read-models/process-outbound.js';
import { projectProcessForOutbound } from '../application/read-models/process-outbound.js';

export {
  SECRET_REDACTION_PLACEHOLDER,
  redactSnippetForOutbound,
  redactTextForOutbound,
  redactUrl,
} from './text.js';

export interface StructuredRedactionOptions {
  maxDepth?: number;
  maxEntries?: number;
}

export type OutboundRedactionRequest =
  | { source: 'provider-exchange'; value: ProviderExchangePayload }
  | { source: 'logged-event'; value: LoggedEvent }
  | { source: 'control-action'; value: ControlActionAuditEntry }
  | { source: 'operator-card'; value: OperatorCard }
  | { source: 'runtime-card-runs'; value: RuntimeCardRunsResponse }
  | { source: 'card-history'; value: CardHistoryHeader | CardHistoryEntry }
  | { source: 'card-diff'; value: CardDiffEntry[] }
  | { source: 'config'; value: SaivageConfig }
  | { source: 'process-view'; value: ProcessOutboundValue }
  | { source: 'dynamic'; value: unknown; options?: StructuredRedactionOptions };

export type OutboundRedactionResult<Request extends OutboundRedactionRequest> =
  Request extends { source: 'provider-exchange' } ? ProviderExchangePayload
    : Request extends { source: 'logged-event' } ? LoggedEvent
      : Request extends { source: 'control-action' } ? ControlActionAuditEntry
        : Request extends { source: 'operator-card' } ? OperatorCard
          : Request extends { source: 'runtime-card-runs' } ? RuntimeCardRunsResponse
            : Request extends { source: 'card-history'; value: infer Value } ? Value
              : Request extends { source: 'card-diff' } ? CardDiffEntry[]
                : Request extends { source: 'config' } ? SaivageConfig
                  : Request extends { source: 'process-view'; value: infer Value } ? Value
                    : unknown;

export const OUTBOUND_REDACTION_SOURCES = [
  'provider-exchange',
  'logged-event',
  'control-action',
  'operator-card',
  'runtime-card-runs',
  'card-history',
  'card-diff',
  'config',
  'process-view',
  'dynamic',
] as const satisfies readonly OutboundRedactionRequest['source'][];
const outboundSourceCompileGuard = {
  'provider-exchange': true,
  'logged-event': true,
  'control-action': true,
  'operator-card': true,
  'runtime-card-runs': true,
  'card-history': true,
  'card-diff': true,
  config: true,
  'process-view': true,
  dynamic: true,
} as const satisfies Record<OutboundRedactionRequest['source'], true>;
void outboundSourceCompileGuard;

export function redactForOutbound<Request extends OutboundRedactionRequest>(request: Request): OutboundRedactionResult<Request>;
/** Temporary phase-only signature for complete owners not cut over until ordered tasks 3-10. */
export function redactForOutbound<T>(value: T, options?: StructuredRedactionOptions): T;
export function redactForOutbound(input: unknown, options: StructuredRedactionOptions = {}): unknown {
  if (!isTypedRequest(input)) return projectLegacyStructuredValue(input, options);

  switch (input.source) {
    case 'provider-exchange': return projectProviderExchange(input.value);
    case 'logged-event': return projectLoggedEvent(input.value);
    case 'control-action': return projectControlAction(input.value);
    case 'operator-card': return projectOperatorCard(input.value);
    case 'runtime-card-runs': return projectRuntimeCardRuns(input.value);
    case 'card-history': return projectCardHistory(input.value);
    case 'card-diff': return projectCardDiff(input.value);
    case 'config': return projectEffectiveConfigForOutbound(input.value);
    case 'process-view': return projectProcessForOutbound(input.value);
    case 'dynamic': return projectDynamicForOutbound(input.value);
    default: return assertNever(input);
  }
}

function isTypedRequest(value: unknown): value is OutboundRedactionRequest {
  if (value === null || typeof value !== 'object' || !('source' in value) || !('value' in value)) return false;
  return (OUTBOUND_REDACTION_SOURCES as readonly unknown[]).includes((value as { source: unknown }).source);
}

function assertNever(value: never): never {
  throw new Error(`Unhandled outbound redaction source: ${JSON.stringify(value)}`);
}

const DEFAULT_MAX_DEPTH = 8;
const DEFAULT_MAX_ENTRIES = 100;
const SECRET_KEY_PATTERN = /\b(?:apiKey|apiToken|botToken|accessToken|refreshToken|(?:api_)?key|token|authorization|.*[A-Z](?:Token|Key|Secret|Password)|.*_(?:key|token|secret|password)|secret|password|credential|credentials?|cookie|set-cookie|auth)\b/i;

// Removed when the remaining ordered owner tasks cut over from the old signature.
function projectLegacyStructuredValue(value: unknown, options: StructuredRedactionOptions): unknown {
  return visitLegacy(value, 0, new WeakSet<object>(), options);
}

function visitLegacy(value: unknown, depth: number, activePath: WeakSet<object>, options: StructuredRedactionOptions): unknown {
  if (typeof value === 'string') return redactTextForOutbound(value);
  if (value instanceof Error) return redactTextForOutbound(value.message);
  if (value === null || typeof value !== 'object') return value;
  if (activePath.has(value)) return '[Circular]';
  if (depth >= (options.maxDepth ?? DEFAULT_MAX_DEPTH)) return '[MaxDepth]';

  activePath.add(value);
  try {
    const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
    if (Array.isArray(value)) {
      const output = value.slice(0, maxEntries).map((entry) => visitLegacy(entry, depth + 1, activePath, options));
      if (value.length > maxEntries) output.push(`[${value.length - maxEntries} entries truncated]`);
      return output;
    }
    const entries = Object.entries(value as Record<string, unknown>);
    const output: Record<string, unknown> = {};
    for (const [key, entryValue] of entries.slice(0, maxEntries)) {
      output[key] = SECRET_KEY_PATTERN.test(key) ? '[REDACTED]' : visitLegacy(entryValue, depth + 1, activePath, options);
    }
    if (entries.length > maxEntries) output.__truncated__ = `${entries.length - maxEntries} entries truncated`;
    return output;
  } finally {
    activePath.delete(value);
  }
}
