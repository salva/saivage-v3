import type { ProviderExchangePayload } from '../contracts/provider-exchange.js';
import type {
  LoggedEvent,
  ControlActionAuditEntry,
  CardHistoryEntry,
  CardHistoryHeader,
} from '../schemas/index.js';
import type { CardDiffEntry } from '../cards/card-service.js';
import { projectProviderExchange } from '../agents/provider-exchange-outbound.js';
import { projectLoggedEvent } from '../observability/logged-event-projection.js';
import { projectControlAction } from '../persistence/control-action-outbound.js';
import { projectDynamicForOutbound } from './dynamic.js';
import {
  projectCardDiff,
  projectCardHistory,
} from '../application/read-models/card-outbound.js';
import type { SaivageConfig } from '../schemas/saivage-config.js';
import { projectEffectiveConfigForOutbound } from '../config/effective-config-outbound.js';
import type { ProcessOutboundValue } from '../application/read-models/process-outbound.js';
import { projectProcessForOutbound } from '../application/read-models/process-outbound.js';
import type { WebfetchInvocation, WebfetchResult } from '../contracts/webfetch.js';
import {
  projectWebfetchInvocationForOutbound,
  projectWebfetchResultForOutbound,
} from '../tools/webfetch-outbound.js';
import type { ToolInvocationProjectionInput } from '../contracts/tool-invocation-projection.js';
import { projectToolInvocation } from '../tools/tool-invocation-outbound.js';
import type { KnownWsEnvelopeWithClassifiedToolActivity } from '../contracts/operator-events.js';
import { projectWsEnvelopeForOutbound } from './ws-envelope.js';
import type { InternalMcpToolsReadModel } from '../mcp/status-projection.js';
import { projectMcpToolsForOutbound } from '../mcp/mcp-outbound.js';
import type { McpToolsResponse } from '../contracts/operator-api-mcp.js';

export {
  SECRET_REDACTION_PLACEHOLDER,
  redactSnippetForOutbound,
  redactTextForOutbound,
  redactUrl,
} from './text.js';

export type OutboundRedactionRequest =
  | { source: 'provider-exchange'; value: ProviderExchangePayload }
  | { source: 'logged-event'; value: LoggedEvent }
  | { source: 'control-action'; value: ControlActionAuditEntry }
  | { source: 'card-history'; value: CardHistoryHeader | CardHistoryEntry }
  | { source: 'card-diff'; value: CardDiffEntry[] }
  | { source: 'config'; value: SaivageConfig }
  | { source: 'process-view'; value: ProcessOutboundValue }
  | { source: 'webfetch-invocation'; value: WebfetchInvocation }
  | { source: 'webfetch-result'; value: WebfetchResult }
  | { source: 'tool-invocation'; value: ToolInvocationProjectionInput }
  | { source: 'ws-envelope'; value: KnownWsEnvelopeWithClassifiedToolActivity }
  | { source: 'mcp-tools'; value: InternalMcpToolsReadModel }
  | { source: 'dynamic'; value: unknown };

export type OutboundRedactionResult<Request extends OutboundRedactionRequest> = Request extends {
  source: 'provider-exchange';
}
  ? ProviderExchangePayload
  : Request extends { source: 'logged-event' }
    ? LoggedEvent
    : Request extends { source: 'control-action' }
      ? ControlActionAuditEntry
       : Request extends { source: 'card-history'; value: infer Value }
            ? Value
            : Request extends { source: 'card-diff' }
              ? CardDiffEntry[]
              : Request extends { source: 'config' }
                ? SaivageConfig
                : Request extends { source: 'process-view'; value: infer Value }
                  ? Value
                  : Request extends { source: 'webfetch-invocation' }
                    ? WebfetchInvocation
                    : Request extends { source: 'webfetch-result' }
                      ? WebfetchResult
                      : Request extends { source: 'tool-invocation' }
                        ? ToolInvocationProjectionInput
                        : Request extends { source: 'ws-envelope' }
                          ? KnownWsEnvelopeWithClassifiedToolActivity
                          : Request extends { source: 'mcp-tools' }
                              ? McpToolsResponse
                              : unknown;

type ExactOutboundRedactionRequest<Request extends OutboundRedactionRequest> = Request &
  Record<
    Exclude<keyof Request, keyof Extract<OutboundRedactionRequest, { source: Request['source'] }>>,
    never
  >;

export const OUTBOUND_REDACTION_SOURCES = [
  'provider-exchange',
  'logged-event',
  'control-action',
  'card-history',
  'card-diff',
  'config',
  'process-view',
  'webfetch-invocation',
  'webfetch-result',
  'tool-invocation',
  'ws-envelope',
  'mcp-tools',
  'dynamic',
] as const satisfies readonly OutboundRedactionRequest['source'][];

export function redactForOutbound<Request extends OutboundRedactionRequest>(
  request: ExactOutboundRedactionRequest<Request>,
): OutboundRedactionResult<Request>;
export function redactForOutbound(input: OutboundRedactionRequest): unknown {
  switch (input.source) {
    case 'provider-exchange':
      return projectProviderExchange(input.value);
    case 'logged-event':
      return projectLoggedEvent(input.value);
    case 'control-action':
      return projectControlAction(input.value);
    case 'card-history':
      return projectCardHistory(input.value);
    case 'card-diff':
      return projectCardDiff(input.value);
    case 'config':
      return projectEffectiveConfigForOutbound(input.value);
    case 'process-view':
      return projectProcessForOutbound(input.value);
    case 'webfetch-invocation':
      return projectWebfetchInvocationForOutbound(input.value);
    case 'webfetch-result':
      return projectWebfetchResultForOutbound(input.value);
    case 'tool-invocation':
      return projectToolInvocation(input.value);
    case 'ws-envelope':
      return projectWsEnvelopeForOutbound(input.value);
    case 'mcp-tools':
      return projectMcpToolsForOutbound(input.value);
    case 'dynamic':
      return projectDynamicForOutbound(input.value);
    default:
      return assertNever(input);
  }
}

function assertNever(value: never): never {
  throw new Error(`Unhandled outbound redaction source: ${JSON.stringify(value)}`);
}
