import type { DirectObjectAuthority } from './direct-object-authority.js';
import type { CardService } from '../cards/store-api.js';
import type { EventQueryService } from '../application/index.js';
import type { ProcessRunner } from '../runtime/runtime-api.js';
import type { ConversationSessionId } from '../schemas/index.js';
import type { ExecutingLlmSnapshot } from '../runtime/runtime-api.js';
import type { RuntimeApi } from '../runtime/runtime-api.js';
import {
  AgentOperatorReadModelService,
  AgentCurrentStateUnavailableError,
  AgentSessionNotFoundError,
  buildProcessView,
} from '../application/index.js';
import { eventKindValues } from '../schemas/index.js';
import { emptyInput } from './tool-definition.js';
import {
  defineToolBinder,
  executeToolAction,
  OBSERVATIONAL_READ_RESULT_POLICY_TEMPLATE,
  OPERATIONAL_RESULT_POLICY_TEMPLATE,
  type ToolBinder,
} from './invocation.js';
import {
  listAgentSessionsInputSchema,
  listProcessesInputSchema,
  queueNotificationInputSchema,
  readAgentSessionInputSchema,
  readRuntimeErrorsInputSchema,
  readRuntimeEventsInputSchema,
  toolFailed,
  toolSucceeded,
  type ToolActionOutcome,
} from '../contracts/index.js';
import { toolFailureFromError } from './analyst-tool-helpers.js';
import { DISCOVERY_RESPONSE_MAX_BYTES, packCollectionData } from './response-packer.js';
import type { QueueNotificationToolInput } from './notification-tool.js';
import type { ToolExecutionResult } from './invocation.js';
import type { ReadAgentSessionInput } from '../contracts/builtin-tool-inputs.js';

const DEFAULT_LIMIT = 50;

function observationReadFailure(error: unknown): ToolActionOutcome {
  const cause = error instanceof AgentCurrentStateUnavailableError ? error.cause : error;
  if (cause instanceof Error && typeof (cause as NodeJS.ErrnoException).code === 'string')
    return toolFailureFromError(error);
  throw cause;
}

export interface GlobalObservationToolContext {
  readonly authority: DirectObjectAuthority;
  readonly agentName: import('../schemas/index.js').AgentName;
  readonly projectRoot: string;
  readonly store: CardService;
  readonly processRunner: ProcessRunner;
  readonly eventQueries: EventQueryService;
  readonly runtime: Pick<RuntimeApi, 'getStatus'>;
  readonly currentProcessPosition?: (cardId: string) => unknown | null;
  readonly queueNotification: (
    input: QueueNotificationToolInput,
    signal: AbortSignal,
    authority: DirectObjectAuthority,
  ) => Promise<ToolExecutionResult<'none'>>;
  readonly captureExecutingLlmSnapshots: () => ReadonlyMap<
    ConversationSessionId,
    ExecutingLlmSnapshot
  >;
}

async function getStatus(ctx: GlobalObservationToolContext): Promise<ToolActionOutcome> {
  try {
    const runtime = ctx.runtime.getStatus();
    const cards = ctx.store.list();
    const statusCounts = cards.reduce<Record<string, number>>((counts, card) => {
      counts[card.lifecycle.status] = (counts[card.lifecycle.status] ?? 0) + 1;
      return counts;
    }, {});
    return toolSucceeded({
      runtime,
      runtimeSummary: { status: runtime.status, currentCardId: runtime.currentCardId },
      runningProcesses: ctx.processRunner.list({ status: 'running' }).length,
      statusCounts,
      counts: {
        stopped: statusCounts.stopped ?? 0,
        done: statusCounts.done ?? 0,
        failed: statusCounts.failed ?? 0,
        blocked: statusCounts.blocked ?? 0,
        total: cards.length,
      },
    });
  } catch (error) {
    return observationReadFailure(error);
  }
}

function packed(
  items: readonly unknown[],
  position: { item_index: number; item_byte_offset: number } | undefined,
  responseBytes: number | undefined,
  key: string,
  base: Record<string, unknown> = {},
  wholeItems = false,
): ToolActionOutcome {
  const { data } = packCollectionData({
    cap: responseBytes ?? DISCOVERY_RESPONSE_MAX_BYTES,
    total: items.length,
    position: position ?? { item_index: 0, item_byte_offset: 0 },
    item: (index) => items[index]!,
    wholeItems,
    render: (page) => ({ ...base, [key]: page }),
  });
  return toolSucceeded(data);
}
async function listAgentSessions(
  ctx: GlobalObservationToolContext,
  params: { position?: { item_index: number; item_byte_offset: number }; response_bytes?: number },
): Promise<ToolActionOutcome> {
  try {
    const response = new AgentOperatorReadModelService(
      ctx.projectRoot,
      ctx.store.workflows,
      ctx.captureExecutingLlmSnapshots,
    ).listSessions();
    return packed(response.sessions, params.position, params.response_bytes, 'sessions');
  } catch (error) {
    return observationReadFailure(error);
  }
}

async function readAgentSession(
  ctx: GlobalObservationToolContext,
  input: ReadAgentSessionInput,
): Promise<ToolActionOutcome> {
  try {
    const service = new AgentOperatorReadModelService(
      ctx.projectRoot,
      ctx.store.workflows,
      ctx.captureExecutingLlmSnapshots,
    );
    const response =
      input.section === 'diagnostics' || input.section === 'message'
        ? service.readCurrentNavigation(
            input.session_id,
            input.section === 'diagnostics'
              ? { section: 'diagnostics', lastN: input.last_n ?? DEFAULT_LIMIT }
              : { section: 'message', messageId: input.message_id },
          )
        : service.readCurrentSegmentTail(
            input.session_id,
            'last_n' in input ? (input.last_n ?? DEFAULT_LIMIT) : DEFAULT_LIMIT,
          );
    if (response.kind === 'empty')
      return toolFailed('Agent session has no current conversation segment.', {
        code: 'agent_session_empty',
        session_id: input.session_id,
      });
    const section = input.section ?? 'messages';
    const base = {
      session: response.session,
      ownership: response.ownership,
      segment_version: response.conversation.segmentVersion,
      segment_id: response.conversation.segmentId,
      section,
      has_segment_context: response.conversation.segmentContext !== null,
      total_visible_entries: response.conversation.totalEntries,
    };
    const conversation = response.conversation;
    if ('kind' in conversation) {
      if (conversation.kind === 'diagnostics')
        return packed(
          conversation.diagnostics,
          input.position,
          input.response_bytes,
          'diagnostics',
          { ...base, ...conversation.coverage },
          true,
        );
      if (!conversation.match)
        return toolFailed('Agent message not found in the current visible segment.', {
          code: 'agent_message_not_found',
          session_id: input.session_id,
          segment_id: conversation.segmentId,
          segment_version: conversation.segmentVersion,
        });
      return packed([conversation.match.entry], input.position, input.response_bytes, 'message', {
        ...base,
        entry_origin: conversation.match.origin,
        ...(conversation.match.origin === 'carried_synthesized_notice'
          ? { original_event_metadata: 'not_available' }
          : {}),
      });
    }
    return section === 'messages'
      ? packed(conversation.entries, input.position, input.response_bytes, 'messages', base)
      : packed(
          response.conversation.segmentContext === null
            ? []
            : [response.conversation.segmentContext],
          input.position,
          input.response_bytes,
          'context',
          base,
        );
  } catch (error) {
    if (error instanceof AgentSessionNotFoundError)
      return toolFailed('Agent session not found.', {
        code: 'agent_session_not_found',
        session_id: input.session_id,
      });
    if (error instanceof AgentCurrentStateUnavailableError) {
      if (
        !(error.cause instanceof Error) ||
        typeof (error.cause as NodeJS.ErrnoException).code !== 'string'
      )
        throw error.cause;
      return toolFailed('Current Agent session state unavailable; restart required.', {
        code: 'current_state_unavailable',
        resource: error.resource,
        owner_id: error.ownerId,
        restart_required: true,
      });
    }
    throw error;
  }
}

export const globalObservationToolBinders: readonly ToolBinder<
  GlobalObservationToolContext,
  any
>[] = Object.freeze([
  defineToolBinder({
    name: 'get_status',
    description: 'Get bounded overall project and runtime status.',
    resultPolicyTemplate: OBSERVATIONAL_READ_RESULT_POLICY_TEMPLATE,
    inputSchema: () => emptyInput,
    executor: (ctx) => executeToolAction('observational_query', () => getStatus(ctx)),
  }),
  defineToolBinder({
    name: 'read_runtime_events',
    description: 'Read a byte-packed page from the newest selected runtime events.',
    resultPolicyTemplate: OBSERVATIONAL_READ_RESULT_POLICY_TEMPLATE,
    inputSchema: () => readRuntimeEventsInputSchema,
    executor: (ctx, args) =>
      executeToolAction('observational_query', async () => {
        try {
          const result = ctx.eventQueries.queryEvents({
            selection: 'newest_tail',
            limit: args.limit ?? DEFAULT_LIMIT,
            ...(args.kind ? { kind: args.kind as (typeof eventKindValues)[number] } : {}),
          });
          return packed(result.events, args.position, args.response_bytes, 'events', {
            total_lines: result.total,
            parse_errors: 0,
          });
        } catch (error) {
          return observationReadFailure(error);
        }
      }),
  }),
  defineToolBinder({
    name: 'read_runtime_errors',
    description: 'Read a byte-packed page from the newest selected runtime errors.',
    resultPolicyTemplate: OBSERVATIONAL_READ_RESULT_POLICY_TEMPLATE,
    inputSchema: () => readRuntimeErrorsInputSchema,
    executor: (ctx, args) =>
      executeToolAction('observational_query', async () => {
        try {
          const result = ctx.eventQueries.queryErrors(args.limit ?? DEFAULT_LIMIT);
          return packed(result.errors, args.position, args.response_bytes, 'errors', {
            total_lines: result.total,
            parse_errors: 0,
          });
        } catch (error) {
          return observationReadFailure(error);
        }
      }),
  }),
  defineToolBinder({
    name: 'list_processes_tool',
    description:
      'List recorded runtime process observations as a byte-packed page, optionally filtered by status (including unavailable). Query success does not assert process success or containment. Evidence distinguishes group authority, actual leader exit, stream settlement and capture errors. Unavailable entries remain inspectable, not transferable to another activation; operator service-level intervention is required. Process output remains available through bounded read(work:///...).',
    resultPolicyTemplate: OBSERVATIONAL_READ_RESULT_POLICY_TEMPLATE,
    inputSchema: () => listProcessesInputSchema,
    executor: (ctx, args) =>
      executeToolAction('observational_query', async () => {
        try {
          const values = ctx.processRunner
            .list(args.cardId ? { cardId: args.cardId } : undefined)
            .map((record: ReturnType<ProcessRunner['list']>[number]) =>
              buildProcessView(ctx.projectRoot, record),
            );
          const filtered = args.status
            ? values.filter(
                (value: ReturnType<typeof buildProcessView>) => value.status === args.status,
              )
            : values;
          return packed(filtered, args.position, args.response_bytes, 'processes');
        } catch (error) {
          return observationReadFailure(error);
        }
      }),
  }),
  defineToolBinder({
    name: 'list_agent_sessions',
    description:
      'List authoritative durable selected-global and active-card agent sessions as a byte-packed page.',
    resultPolicyTemplate: OBSERVATIONAL_READ_RESULT_POLICY_TEMPLATE,
    inputSchema: () => listAgentSessionsInputSchema,
    executor: (ctx, args) =>
      executeToolAction('observational_query', () => listAgentSessions(ctx, args)),
  }),
  defineToolBinder({
    name: 'read_agent_session',
    description:
      "Read a bounded canonical admitted session. For failure/activation questions start with section 'diagnostics': readable actual current-segment rows, filtered before last_n (default 50), excluding inherited notices. Compare row timestamps and recorded caller linkage in explicitly named parent/child sessions before calling a failure fresh. Counts/endpoints describe only the selected segment/tail; next=null exhausts that tail, not lifetime history. Previews are redacted UTF-8 excerpts, not conclusions; success does not prove child execution. Inspect detail with section 'message' and exact message_id. Messages remain the default tail. When has_segment_context is true and prior compacted history matters, read section 'context', then page messages. Carried synthesized notices have no original event metadata: their epoch/coordinates are placeholders, not fresh evidence. For sliced message/context items hex-decode content_hex chunks, concatenate at decoded-byte positions, then UTF-8-decode and JSON-parse the whole item. Copy next unchanged with the same query; never use a final slice endpoint as continuation. Positions are stateless: compare exact segment UUID/version and coverage endpoints; changed rows/selection require fresh observation, not automatic retry. Diagnostics uses whole items and zero item_byte_offset only; raise response_bytes if an item cannot fit. Use get_card for current lifecycle, get_status for runtime; absent/truncated evidence is not proof of absence. Unknown effects never authorize replay.",
    resultPolicyTemplate: OBSERVATIONAL_READ_RESULT_POLICY_TEMPLATE,
    inputSchema: () => readAgentSessionInputSchema,
    executor: (ctx, args) =>
      executeToolAction('observational_query', () => readAgentSession(ctx, args)),
  }),
  defineToolBinder({
    name: 'queue_notification',
    description:
      'Queue context to an eligible card’s designated recipient. Analyst uses ordinary notification admission, including non-planning cards; normal enqueue needs no Pause or Run. Oversight may notify only eligible planning targets during its admitted running-runtime check. Urgent may interrupt exact active card work; enqueue alone does not prove delivery or action.',
    resultPolicyTemplate: OPERATIONAL_RESULT_POLICY_TEMPLATE,
    inputSchema: () => queueNotificationInputSchema,
    executor: (ctx, args, signal) => ctx.queueNotification(args, signal, ctx.authority),
  }),
]);
