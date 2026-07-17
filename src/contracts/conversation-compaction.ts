import { createHash } from 'node:crypto';

import { canonicalJson, parseCanonicalContextCompaction, type AgentMessage, type ContextCompactionContent } from '../schemas/index.js';
import { classifyConversationSourceRows, type SourceRound } from './conversation-source-classification.js';

export type ValidatedCompactionSegment = {
  kind: 'initial' | 'repair';
  sourceRows: AgentMessage[];
  repairAnchor: AgentMessage | null;
};

export type ValidatedCompactionRound = {
  complete: boolean;
  label: string;
  sourceRows: AgentMessage[];
  segments: ValidatedCompactionSegment[];
};

export type ValidatedCompactionGroup = {
  payload: ContextCompactionContent['summaries'][number];
  rounds: ValidatedCompactionRound[];
  sourceRows: AgentMessage[];
};

export type ValidatedContextCompaction = {
  metadataRow: AgentMessage;
  payload: ContextCompactionContent;
  groups: ValidatedCompactionGroup[];
  cutoffSourceIndex: number;
  cutoffMessageId: string;
  boundary: ContextCompactionContent['boundary'];
  renderedContext: string;
};

export type ValidatedConversation = {
  sourceSessionId: string;
  physicalRows: AgentMessage[];
  sourceRows: AgentMessage[];
  compactions: ValidatedContextCompaction[];
  latestCompaction: ValidatedContextCompaction | null;
};

export function validateConversationRows(sourceSessionId: string, physicalRows: readonly AgentMessage[]): ValidatedConversation {
  const wrongSession = physicalRows.find((row) => row.session_id !== sourceSessionId);
  if (wrongSession) throw new Error(`Conversation row '${wrongSession.id}' belongs to session '${wrongSession.session_id}', not source session '${sourceSessionId}'.`);
  if (new Set(physicalRows.map((row) => row.id)).size !== physicalRows.length) throw new Error('Conversation contains duplicate message ids.');
  const sourceRows: AgentMessage[] = [];
  const compactions: ValidatedContextCompaction[] = [];
  for (const row of physicalRows) {
    if (row.kind !== 'context_compaction') {
      sourceRows.push(row);
      continue;
    }
    compactions.push(validateCompaction(row, sourceRows));
  }
  classifyConversationSourceRows(sourceSessionId, sourceRows);
  return { sourceSessionId, physicalRows: [...physicalRows], sourceRows, compactions, latestCompaction: compactions.at(-1) ?? null };
}

function validateCompaction(metadataRow: AgentMessage, precedingSourceRows: readonly AgentMessage[]): ValidatedContextCompaction {
  const payload = parseCanonicalContextCompaction(metadataRow.content);
  const classification = classifyConversationSourceRows(metadataRow.session_id, precedingSourceRows);
  const byId = new Map(precedingSourceRows.map((row) => [row.id, row]));
  const groups: ValidatedCompactionGroup[] = [];
  let roundIndex = 0;

  for (const group of payload.summaries) {
    const validatedRounds: ValidatedCompactionRound[] = [];
    for (const roundPayload of group.rounds) {
      const classifiedRound = classification.rounds[roundIndex++];
      if (!classifiedRound) throw new Error('Compaction references more rounds than physically preceding source rows contain.');
      const segmentIds = roundPayload.segments.flatMap((segment) => segment.source_message_ids);
      const resolved = segmentIds.map((id) => {
        const source = byId.get(id);
        if (!source) throw new Error(`Compaction source message '${id}' is not a physically preceding source row.`);
        return source;
      });
      const expectedRows = roundPayload.complete ? classifiedRound.rows : classifiedRound.rows.slice(0, resolved.length);
      assertIdsEqual(resolved, expectedRows, `Compaction round '${classifiedRound.label}' is not the canonical ${roundPayload.complete ? 'complete round' : 'round prefix'}.`);
      if (!roundPayload.complete && resolved.length >= classifiedRound.rows.length) throw new Error(`Partial compaction round '${classifiedRound.label}' must omit a non-empty suffix.`);
      const expectedSegments = sourceSegmentsForPrefix(classifiedRound, resolved.length);
      if (roundPayload.segments.length !== expectedSegments.length) throw new Error(`Compaction round '${classifiedRound.label}' has incorrect source segmentation.`);
      const segments = roundPayload.segments.map((segment, segmentIndex) => {
        const expected = expectedSegments[segmentIndex]!;
        if (segment.kind !== expected.kind) throw new Error(`Compaction round '${classifiedRound.label}' has incorrect source segmentation.`);
        const segmentRows = segment.source_message_ids.map((id) => byId.get(id)!);
        assertIdsEqual(segmentRows, expected.rows, `Compaction round '${classifiedRound.label}' has incorrect source segmentation.`);
        return { kind: segment.kind, sourceRows: segmentRows, repairAnchor: segment.kind === 'repair' ? segmentRows[0]! : null };
      });
      validatedRounds.push({ complete: roundPayload.complete, label: classifiedRound.label, sourceRows: resolved, segments });
    }
    const groupRows = validatedRounds.flatMap((round) => round.sourceRows);
    if (hashConversationRows(groupRows) !== group.content_hash) throw new Error('Compaction raw content hash mismatch.');
    groups.push({ payload: group, rounds: validatedRounds, sourceRows: groupRows });
  }

  const coveredRows = groups.flatMap((group) => group.sourceRows);
  if (coveredRows.length === 0) throw new Error('Compaction must cover source rows.');
  const canonicalCovered = classification.rounds.slice(0, roundIndex).flatMap((round, index) => {
    const validated = groups.flatMap((group) => group.rounds)[index]!;
    return validated.complete ? round.rows : round.rows.slice(0, validated.sourceRows.length);
  });
  assertIdsEqual(coveredRows, canonicalCovered, 'Compaction coverage is not the canonical source prefix.');

  const retainedStaticIds = classification.preamble.filter((row) => row.role === 'system' && row.kind !== 'activity').map((row) => row.id);
  if (JSON.stringify(payload.retained_static_message_ids) !== JSON.stringify(retainedStaticIds)) throw new Error('Compaction retained static message ids do not match the eligible preceding preamble.');

  const cutoff = coveredRows.at(-1)!;
  const cutoffSourceIndex = precedingSourceRows.findIndex((row) => row.id === cutoff.id);
  const finalRound = groups.at(-1)!.rounds.at(-1)!;
  if (!finalRound.complete) {
    const classifiedFinalRound = classification.rounds[roundIndex - 1]!;
    const next = classifiedFinalRound.rows[finalRound.sourceRows.length];
    if (!isSafeFallbackBoundary(cutoff, next)) throw new Error(`Partial compaction round '${finalRound.label}' ends inside an indivisible provider bundle.`);
  }
  const expectedBoundary = finalRound.complete ? 'round' : fallbackBoundary(cutoff);
  if (payload.boundary !== expectedBoundary) throw new Error(`Compaction boundary '${payload.boundary}' does not match derived boundary '${expectedBoundary}'.`);
  return { metadataRow, payload, groups, cutoffSourceIndex, cutoffMessageId: cutoff.id, boundary: payload.boundary, renderedContext: renderCompactionContext(groups) };
}

function sourceSegmentsForPrefix(round: SourceRound, length: number): SourceRound['segments'] {
  let remaining = length;
  const segments: SourceRound['segments'] = [];
  for (const segment of round.segments) {
    if (remaining === 0) break;
    const rows = segment.rows.slice(0, remaining);
    if (rows.length > 0) segments.push({ kind: segment.kind, rows });
    remaining -= rows.length;
  }
  return segments;
}

function assertIdsEqual(actual: readonly AgentMessage[], expected: readonly AgentMessage[], message: string): void {
  if (JSON.stringify(actual.map((row) => row.id)) !== JSON.stringify(expected.map((row) => row.id))) throw new Error(message);
}

export function renderCompactionContext(groups: readonly ValidatedCompactionGroup[]): string {
  return groups.map((group) => {
    const labels = group.rounds.map((round) => round.label);
    const heading = group.payload.kind === 'merged'
      ? `Merged history rounds ${labels.join(', ')}`
      : `Round ${labels[0]}${group.rounds[0]!.complete ? '' : ' (partial prefix)'}`;
    return `${heading}:\n${group.payload.summary_text}${renderEvidence(group.payload.evidence)}`;
  }).join('\n\n');
}

function renderEvidence(evidence: readonly unknown[]): string {
  return evidence.length === 0 ? '' : `\nRecoverable evidence:\n${evidence.map((item) => `- ${canonicalJson(item)}`).join('\n')}`;
}

export function hashConversationRows(rows: readonly AgentMessage[]): string {
  const text = rows.map((row) => JSON.stringify({ id: row.id, role: row.role, kind: row.kind, content: row.content, tool: row.tool, tool_call_id: row.tool_call_id, source_input_id: undefined })).join('\n');
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function fallbackBoundary(row: AgentMessage): 'repair' | 'exchange' | 'message' {
  if (row.kind === 'tool_result') return failedResult(row) ? 'repair' : 'exchange';
  return 'message';
}

function isSafeFallbackBoundary(last: AgentMessage, next: AgentMessage | undefined): boolean {
  if (last.kind === 'tool_call' || next?.kind === 'tool_result') return false;
  if (last.kind === 'provider_private' || next?.provider_projection?.private_message_id === last.id) return false;
  return true;
}

function failedResult(row: AgentMessage): boolean {
  try { return JSON.parse(row.content).success === false; } catch { return false; }
}
