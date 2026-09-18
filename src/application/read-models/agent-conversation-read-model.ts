import { projectCanonicalConversationRow } from './canonical-conversation-outbound.js';
import { currentCoveredRequiredFactRows } from '../../runtime/actors/context/composition-projector.js';
import {
  ConversationHistoricalVersionNotFoundError,
  readCurrentConversationSegment,
  type ConversationSegment,
} from '../../persistence/conversation-file.js';
import type { ConversationSegmentGenesis } from '../../persistence/canonical-conversation-artifacts.js';
import { type AgentMessage, type ConversationSessionId } from '../../schemas/index.js';
import type { ConversationSegmentContext } from '../../contracts/index.js';
import { projectToolInvocation } from '../../tools/tool-invocation-outbound.js';
import { redactTextForOutbound } from '../../redaction/text.js';

export interface FoldedConversation {
  readonly sessionId: ConversationSessionId;
  readonly entries: readonly AgentMessage[];
  readonly cursor: string | null;
  readonly totalEntries: number;
  readonly segmentVersion: number;
  readonly segmentContext: ConversationSegmentContext;
}

export class ConversationSegmentChangedError extends Error {
  constructor(readonly requestedVersion: number, readonly currentVersion: number) {
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
  options: { segmentVersion?: number; since?: string; lastN?: number } = {},
): FoldedConversation {
  const segment = readCurrentConversationSegment(projectRoot, sessionId);
  if (!segment) throw new ConversationHistoricalVersionNotFoundError();
  if (options.segmentVersion !== undefined && options.segmentVersion !== segment.entry.version)
    throw new ConversationSegmentChangedError(options.segmentVersion, segment.entry.version);

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
        source_kind: genesis.compaction.source.kind,
        prior_genesis_id: genesis.compaction.source.kind === 'prior_genesis_plus_current_rows' ? genesis.compaction.source.priorGenesisId : null,
        prior_history_hash: genesis.compaction.source.kind === 'prior_genesis_plus_current_rows' ? genesis.compaction.source.priorHistoryHash : null,
        covered_group_count: genesis.compaction.source.groups.length,
        protected_prompts: genesis.compaction.protectedPrompts.map((entry) => {
          const message = projectCanonicalConversationRow(entry.message, projectToolInvocation);
          return { source: { segment_version: entry.source.segmentVersion, row_index: entry.source.rowIndex }, message: message.context_policy.kind === 'content' && message.context_policy.compaction_key !== undefined ? { ...message, context_policy: { ...message.context_policy, compaction_key: redactTextForOutbound(message.context_policy.compaction_key) } } : message };
        }),
        dispositions: {
          sha256: genesis.compaction.dispositionCommitment.sha256,
          count: genesis.compaction.dispositionCommitment.count,
          summarized: genesis.compaction.dispositionCommitment.summarized,
          evidence_only: genesis.compaction.dispositionCommitment.evidenceOnly,
          superseded: genesis.compaction.dispositionCommitment.superseded,
          protected: genesis.compaction.dispositionCommitment.protected,
        },
        coverage: {
          source_session_id: genesis.compaction.coverageCommitment.sourceSessionId,
          source_version: genesis.compaction.coverageCommitment.sourceVersion,
          covered_through_message_id: genesis.compaction.coverageCommitment.coveredThroughMessageId,
          covered_source_groups_sha256: genesis.compaction.coverageCommitment.coveredSourceGroupsSha256,
          accumulated_summary_sha256: genesis.compaction.coverageCommitment.accumulatedSummarySha256,
          protected_prompts_sha256: genesis.compaction.coverageCommitment.protectedPromptsSha256,
        },
        required_model_facts: genesis.compaction.requiredModelFacts,
        continuation: genesis.continuation,
      });
}

export function foldHistoricalConversationRows(rows: readonly AgentMessage[]): readonly AgentMessage[] {
  return rows.filter((row) => row.kind !== 'provider_private').map((row) => {
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
