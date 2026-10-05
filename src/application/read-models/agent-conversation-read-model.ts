import { projectCanonicalConversationRow } from './canonical-conversation-outbound.js';
import { currentCoveredRequiredFactRows } from '../../runtime/runtime-api.js';
import {
  ConversationHistoricalVersionNotFoundError,
  readCurrentConversationSegment,
  type ConversationSegment,
  type ConversationSegmentGenesis,
} from '../../persistence/index.js';
import { type AgentMessage, type ConversationSessionId } from '../../schemas/index.js';
import type { ConversationSegmentContext } from '../../contracts/index.js';
import { projectToolInvocation } from '../../tools/tool-api.js';
import { redactTextForOutbound } from '../../redaction/index.js';

export interface FoldedConversation {
  readonly sessionId: ConversationSessionId;
  readonly entries: readonly AgentMessage[];
  readonly cursor: string | null;
  readonly totalEntries: number;
  readonly segmentVersion: number;
  readonly segmentId: string;
  readonly segmentContext: ConversationSegmentContext;
}

export class ConversationSegmentChangedError extends Error {
  constructor(
    readonly requestedVersion: number,
    readonly currentVersion: number,
    readonly requestedId: string,
    readonly currentId: string,
  ) {
    super('Conversation segment changed.');
  }
}

export class ConversationCursorNotFoundError extends Error {
  constructor(readonly cursor: string) {
    super(`Conversation cursor '${cursor}' was not found.`);
  }
}

export function foldConversation(
  projectRoot: string,
  sessionId: ConversationSessionId,
  options:
    | { segmentId?: undefined; segmentVersion?: undefined; since?: undefined; lastN?: number }
    | { segmentId: string; segmentVersion: number; since: string; lastN?: undefined } = {},
): FoldedConversation {
  const segment = readCurrentConversationSegment(projectRoot, sessionId);
  if (!segment) throw new ConversationHistoricalVersionNotFoundError();
  if (
    options.segmentVersion !== undefined &&
    (options.segmentVersion !== segment.entry.version ||
      options.segmentId !== segment.entry.entry_id)
  )
    throw new ConversationSegmentChangedError(
      options.segmentVersion,
      segment.entry.version,
      options.segmentId,
      segment.entry.entry_id,
    );

  const rows = [...coveredRequiredFactRows(segment), ...segment.rows];
  const selected: AgentMessage[] = [];
  let cursorFound = options.since === undefined;
  let cursor: string | null = options.since ?? null;
  let totalEntries = 0;
  for (const row of rows) {
    if (options.since !== undefined && !cursorFound) {
      if (row.id === options.since) cursorFound = true;
      continue;
    }
    if (row.kind === 'provider_private') continue;
    cursor = row.id;
    const clean = row.provider_projection ? stripProviderProjection(row) : row;
    selected.push(projectCanonicalConversationRow(clean, projectToolInvocation));
    totalEntries += 1;
    if (options.lastN !== undefined && selected.length > options.lastN) selected.shift();
  }
  if (!cursorFound) throw new ConversationCursorNotFoundError(options.since!);
  return Object.freeze({
    sessionId,
    entries: Object.freeze(selected),
    cursor,
    totalEntries,
    segmentVersion: segment.entry.version,
    segmentId: segment.entry.entry_id,
    segmentContext: segmentContext(segment.genesis),
  });
}

export function segmentContext(genesis: ConversationSegmentGenesis): ConversationSegmentContext {
  return genesis.kind === 'ordinary_segment_genesis'
    ? null
    : Object.freeze({
        kind: 'compacted',
        source_version: genesis.source.version,
        covered_through_message_id: genesis.source.covered_through_message_id,
        summary_text: genesis.compaction.summaryText,
        protected_prompts: genesis.compaction.protectedPrompts.map((entry) => {
          const message = projectCanonicalConversationRow(entry.message, projectToolInvocation);
          return {
            source: {
              segment_version: entry.source.segmentVersion,
              row_index: entry.source.rowIndex,
            },
            message:
              message.context_policy.kind === 'content' &&
              message.context_policy.compaction_key !== undefined
                ? {
                    ...message,
                    context_policy: {
                      ...message.context_policy,
                      compaction_key: redactTextForOutbound(message.context_policy.compaction_key),
                    },
                  }
                : message,
          };
        }),
        required_model_facts: genesis.compaction.requiredModelFacts,
        continuation: genesis.continuation,
      });
}

export function foldHistoricalConversationRows(
  rows: readonly AgentMessage[],
): readonly AgentMessage[] {
  return rows
    .filter((row) => row.kind !== 'provider_private')
    .map((row) => {
      const clean = { ...row };
      delete clean.provider_projection;
      return clean;
    });
}

function coveredRequiredFactRows(segment: ConversationSegment): readonly AgentMessage[] {
  if (segment.genesis.kind !== 'compacted_segment_genesis') return [];
  return currentCoveredRequiredFactRows({
    sourceSessionId: segment.conversation.sourceSessionId,
    requiredModelFacts: segment.conversation.effectiveRequiredModelFacts,
    uncoveredRows: segment.conversation.sourceRows,
  });
}

function stripProviderProjection(row: AgentMessage): AgentMessage {
  const result = { ...row };
  delete result.provider_projection;
  return result;
}
