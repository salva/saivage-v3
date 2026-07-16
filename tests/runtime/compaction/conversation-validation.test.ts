import { describe, expect, it } from '@jest/globals';

import { hashConversationRows, validateConversationRows } from '../../../src/contracts/conversation-compaction.js';
import { agentMessageSchema, canonicalJson, contextCompactionContentSchema, type AgentMessage, type ContextCompactionContent } from '../../../src/schemas/index.js';

describe('conversation compaction validation', () => {
  it('derives one ordered summary-group identity and rendering', () => {
    const rows = sourceRound('one');
    const metadata = compaction('c1', payload([{ rows, complete: true }], 'round'));
    const validated = validateConversationRows([...rows, metadata]);

    expect(validated.sourceRows).toEqual(rows);
    expect(validated.latestCompaction).toMatchObject({ cutoffMessageId: 'one-text', cutoffSourceIndex: 1, boundary: 'round' });
    expect(validated.latestCompaction!.groups[0]!.rounds[0]).toMatchObject({ label: 'one-activation', complete: true });
    expect(validated.latestCompaction!.renderedContext).toBe('Round one-activation:\nsummary');
  });

  it('validates each metadata row against preceding source rows only', () => {
    const first = sourceRound('one');
    const second = sourceRound('two', 1);
    const firstMetadata = compaction('c1', payload([{ rows: first, complete: true }], 'round'));
    expect(() => validateConversationRows([...first, firstMetadata, ...second])).not.toThrow();

    const laterReference = compaction('c2', payload([{ rows: second, complete: true }], 'round'));
    expect(() => validateConversationRows([...first, laterReference, ...second])).toThrow(/physically preceding|canonical complete round/);
  });

  it('fails an invalid older metadata row even when a later row is valid', () => {
    const first = sourceRound('one');
    const second = sourceRound('two', 1);
    const invalid = compaction('c1', { ...payload([{ rows: first, complete: true }], 'round'), summaries: [{ ...payload([{ rows: first, complete: true }], 'round').summaries[0]!, content_hash: '0'.repeat(64) }] });
    const valid = compaction('c2', payload([{ rows: first, complete: true }, { rows: second, complete: true }], 'round'));
    expect(() => validateConversationRows([...first, invalid, ...second, valid])).toThrow(/hash mismatch/);
  });

  it.each([
    ['reordered coverage', (base: ContextCompactionContent) => ({ ...base, summaries: [{ ...base.summaries[0]!, rounds: [{ complete: true, segments: [{ kind: 'initial' as const, source_message_ids: ['one-text', 'one-activation'] }] }] }] })],
    ['gap in coverage', (base: ContextCompactionContent) => ({ ...base, summaries: [{ ...base.summaries[0]!, rounds: [{ complete: true, segments: [{ kind: 'initial' as const, source_message_ids: ['one-activation'] }] }] }] })],
    ['incorrect partial classification', (base: ContextCompactionContent) => ({ ...base, boundary: 'message' as const, applied_policy: { ...base.applied_policy, mode: 'hard_limit_fallback' as const }, summaries: [{ ...base.summaries[0]!, rounds: [{ complete: false, segments: [{ kind: 'initial' as const, source_message_ids: ['one-activation', 'one-text'] }] }] }] })],
    ['hash mismatch', (base: ContextCompactionContent) => ({ ...base, summaries: [{ ...base.summaries[0]!, content_hash: '0'.repeat(64) }] })],
    ['retained static mismatch', (base: ContextCompactionContent) => ({ ...base, retained_static_message_ids: ['missing'] })],
    ['wrong boundary', (base: ContextCompactionContent) => ({ ...base, boundary: 'message' as const })],
  ] as Array<[string, (base: ContextCompactionContent) => ContextCompactionContent]>)('rejects %s through the same boundary', (_label, mutate) => {
    const rows = sourceRound('one');
    const base = payload([{ rows, complete: true }], 'round');
    expect(() => validateConversationRows([...rows, compaction('c1', mutate(base))])).toThrow();
  });

  it('rejects incorrect repair segmentation and derives repair anchors', () => {
    const rows = sourceRound('one', 0, true);
    const correct = payload([{ rows, complete: true, repairAt: 2 }], 'round');
    const validated = validateConversationRows([...rows, compaction('c1', correct)]);
    expect(validated.latestCompaction!.groups[0]!.rounds[0]!.segments[1]!.repairAnchor!.id).toBe('one-repair');
    const wrong = { ...correct, summaries: [{ ...correct.summaries[0]!, rounds: [{ complete: true, segments: [{ kind: 'initial' as const, source_message_ids: rows.map((row) => row.id) }] }] }] };
    expect(() => validateConversationRows([...rows, compaction('c2', wrong)])).toThrow(/segmentation/);
  });

  it('rejects the superseded duplicate-identity payload shape', () => {
    expect(contextCompactionContentSchema.safeParse({ cutoff: { round_id: 'r', through_message_id: 'm', boundary: 'round' }, retained_static_message_ids: [], merged_history: null, individual_rounds: [], round_coverage: [], rendered_context: 'old', applied_policy: policy() }).success).toBe(false);
  });

  it.each(['requested_completion_tokens', 'canonical_message_hard_ceiling', 'trigger_line_tokens', 'trigger_message_threshold', 'tail_budget_tokens', 'middle_budget_tokens'])('rejects removed derived policy field %s while accepting the minimal current policy', (field) => {
    const current = payload([{ rows: sourceRound('one'), complete: true }], 'round');
    expect(contextCompactionContentSchema.safeParse(current).success).toBe(true);
    expect(contextCompactionContentSchema.safeParse({ ...current, applied_policy: { ...current.applied_policy, [field]: 1 } }).success).toBe(false);
  });

  it('enforces summary-group ordering, cardinality, partial placement, and global source uniqueness', () => {
    const rows = sourceRound('one');
    const base = payload([{ rows, complete: true }], 'round');
    const individual = base.summaries[0]!;
    const merged = { ...individual, kind: 'merged' as const };
    expect(contextCompactionContentSchema.safeParse({ ...base, summaries: [individual, merged] }).success).toBe(false);
    expect(contextCompactionContentSchema.safeParse({ ...base, summaries: [merged, merged] }).success).toBe(false);
    expect(contextCompactionContentSchema.safeParse({ ...base, summaries: [{ ...individual, rounds: [individual.rounds[0]!, individual.rounds[0]!] }] }).success).toBe(false);
    expect(contextCompactionContentSchema.safeParse({ ...base, summaries: [{ ...individual, rounds: [{ ...individual.rounds[0]!, complete: false }] }] }).success).toBe(false);
  });
});

function sourceRound(name: string, minute = 0, repair = false): AgentMessage[] {
  const timestamp = `2026-07-16T00:${String(minute).padStart(2, '0')}:00.000Z`;
  const rows: AgentMessage[] = [message(`${name}-activation`, 'activity', JSON.stringify({ event: 'activation_open' }), timestamp), message(`${name}-text`, 'text', name, timestamp)];
  if (repair) rows.push(message(`${name}-repair`, 'model_repair', 'repair', timestamp));
  return rows;
}

function message(id: string, kind: AgentMessage['kind'], content: string, timestamp: string): AgentMessage {
  return agentMessageSchema.parse({ id, session_id: 'planner:project', role: kind === 'text' ? 'user' : 'system', kind, content, round_id: 'r-user-00000000000000000000000000000000', message_index: 0, block_index: 0, timestamp });
}

function payload(groups: Array<{ rows: AgentMessage[]; complete: boolean; repairAt?: number; split?: number[] }>, boundary: ContextCompactionContent['boundary']): ContextCompactionContent {
  const summaries = groups.map((group) => {
    const split = group.split ?? [group.rows.length];
    let offset = 0;
    const rounds = split.map((length) => {
      const rows = group.rows.slice(offset, offset + length);
      offset += length;
      const repairAt = group.repairAt;
      const segments = repairAt === undefined
        ? [{ kind: 'initial' as const, source_message_ids: rows.map((row) => row.id) }]
        : [{ kind: 'initial' as const, source_message_ids: rows.slice(0, repairAt).map((row) => row.id) }, { kind: 'repair' as const, source_message_ids: rows.slice(repairAt).map((row) => row.id) }];
      return { complete: group.complete, segments };
    });
    return { kind: 'individual' as const, rounds, content_hash: hashConversationRows(group.rows), summary_text: 'summary', evidence: [] };
  });
  return contextCompactionContentSchema.parse({ boundary, retained_static_message_ids: [], summaries, applied_policy: policy() });
}

function compaction(id: string, content: ContextCompactionContent): AgentMessage {
  return agentMessageSchema.parse({ id, session_id: 'planner:project', role: 'system', kind: 'context_compaction', content: canonicalJson(content), round_id: 'r-compacted-00000000000000000000000000000000', message_index: 0, block_index: 0, timestamp: '2026-07-16T01:00:00.000Z' });
}

function policy(): ContextCompactionContent['applied_policy'] {
  return { mode: 'normal', band: 'normal', input_budget_tokens: 1000, canonical_estimated_static_tokens: 10, trigger_fraction: 0.8, completion_reserve_fraction: 0.2, merge_line_fraction: 0.3, summary_line_fraction: 0.5, snap: 'compact_straddler' };
}
