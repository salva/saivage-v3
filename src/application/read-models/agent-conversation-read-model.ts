import {
  projectCanonicalConversationRow,
  projectRecordObservation,
} from './canonical-conversation-outbound.js';
import { currentCoveredRequiredFactRows } from '../../runtime/runtime-api.js';
import {
  ConversationHistoricalVersionNotFoundError,
  readCurrentConversationSegment,
  type ConversationSegment,
  type ConversationSegmentGenesis,
} from '../../persistence/index.js';
import { type AgentMessage, type ConversationSessionId } from '../../schemas/index.js';
import type { ConversationSegmentContext } from '../../contracts/index.js';
import type { AgentConversationEntry } from '../../contracts/index.js';
import { projectToolInvocation } from '../../tools/tool-api.js';
import { redactTextForOutbound } from '../../redaction/index.js';
import { projectConversationDiagnostic } from './agent-conversation-diagnostics.js';

export interface FoldedConversation {
  readonly sessionId: ConversationSessionId;
  readonly entries: readonly AgentConversationEntry[];
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

  const rows = visibleRows(segment);
  const selected: AgentConversationEntry[] = [];
  let cursorFound = options.since === undefined;
  let cursor: string | null = options.since ?? null;
  let totalEntries = 0;
  for (const { row } of rows) {
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

export function readConversationNavigation(
  projectRoot: string,
  sessionId: ConversationSessionId,
  query: { section: 'diagnostics'; lastN: number } | { section: 'message'; messageId: string },
) {
  const segment = readCurrentConversationSegment(projectRoot, sessionId);
  if (!segment) throw new ConversationHistoricalVersionNotFoundError();
  const visible = visibleRows(segment)
    .filter(({ row }) => row.kind !== 'provider_private')
    .map(({ row, origin }) => ({
      entry: projectCanonicalConversationRow(stripProviderProjection(row), projectToolInvocation),
      origin,
    }));
  const common = {
    segmentVersion: segment.entry.version,
    segmentId: segment.entry.entry_id,
    segmentContext: segmentContext(segment.genesis),
    totalEntries: visible.length,
  };
  if (query.section === 'message') {
    const match = visible.find(({ entry }) => entry.id === query.messageId);
    return { ...common, kind: 'message' as const, match };
  }
  const diagnostics = visible.flatMap(({ entry, origin }) => {
    const diagnostic = origin === 'segment_row' ? projectConversationDiagnostic(entry) : null;
    return diagnostic === null ? [] : [diagnostic];
  });
  const selected = diagnostics.slice(-query.lastN);
  return {
    ...common,
    kind: 'diagnostics' as const,
    diagnostics: selected,
    coverage: {
      scope: 'current_segment_rows' as const,
      total_diagnostic_entries: diagnostics.length,
      selected_diagnostic_entries: selected.length,
      omitted_earlier_diagnostic_entries: diagnostics.length - selected.length,
      first_message_id: selected[0]?.message_id ?? null,
      last_message_id: selected.at(-1)?.message_id ?? null,
      first_timestamp: selected[0]?.timestamp ?? null,
      last_timestamp: selected.at(-1)?.timestamp ?? null,
      historical_segments_included: false,
      inherited_notices_included: false,
    },
  };
}

function visibleRows(segment: ConversationSegment) {
  return [
    ...coveredRequiredFactRows(segment).map((row) => ({
      row,
      origin: 'carried_synthesized_notice' as const,
    })),
    ...segment.rows.map((row) => ({ row, origin: 'segment_row' as const })),
  ];
}

export function segmentContext(genesis: ConversationSegmentGenesis): ConversationSegmentContext {
  return genesis.kind === 'ordinary_segment_genesis'
    ? null
    : Object.freeze({
        kind: 'compacted',
        source_version: genesis.source.version,
        covered_through_message_id: genesis.source.covered_through_message_id,
        summary_text: redactTextForOutbound(genesis.compaction.summaryText),
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
        required_model_facts: {
          ...genesis.compaction.requiredModelFacts,
          latestRecordObservations:
            genesis.compaction.requiredModelFacts.latestRecordObservations.map((entry) => ({
              source: { ...entry.source, messageId: redactTextForOutbound(entry.source.messageId) },
              observation: projectRecordObservation(entry.observation),
            })),
        },
        continuation: genesis.continuation,
      });
}

export function foldHistoricalConversationRows(
  rows: readonly AgentMessage[],
): readonly AgentConversationEntry[] {
  return rows
    .filter((row) => row.kind !== 'provider_private')
    .map((row) => {
      const clean = { ...row };
      delete clean.provider_projection;
      return projectCanonicalConversationRow(clean, projectToolInvocation);
    });
}

export function coveredRequiredFactRows(segment: ConversationSegment): readonly AgentMessage[] {
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
