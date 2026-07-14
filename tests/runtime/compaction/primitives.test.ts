import { describe, expect, it } from '@jest/globals';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { AgentMessage } from '../../../src/schemas/index.js';
import { appendTestConversationMessage, appendTestSummaryCacheEntry as appendSummaryCacheEntry } from '../../helpers/conversation-mutations.js';
import { computeCompactionBands } from '../../../src/runtime/actors/compaction/bands.js';
import { dropRecoverableResultBodies, recoverableEvidenceDescriptors, type RecoverableEvidenceDescriptor } from '../../../src/runtime/actors/compaction/result-dropping.js';
import { classifyConversationRounds, type ClassifiedRound, type PositionedMessage } from '../../../src/runtime/actors/compaction/round-classifier.js';
import { contentHashForMessages, renderRecoverableEvidenceSection, summaryCacheKey } from '../../../src/runtime/actors/compaction/summary-cache.js';
import { summarizeMerge, summarizeRound, type SummarizerProviderPort } from '../../../src/runtime/actors/compaction/summarizer.js';

const timestamp = '2026-01-01T00:00:00.000Z';

function msg(partial: Partial<AgentMessage> & Pick<AgentMessage, 'id' | 'kind' | 'role' | 'content'>): AgentMessage {
  return {
    session_id: 'session-1',
    round_id: 'r-user-00000000000000000000000000000000',
    message_index: 0,
    block_index: 0,
    timestamp,
    ...partial,
  };
}

function toolCall(id: string, tool: string, args: unknown): AgentMessage {
  return msg({
    id: `call-${id}`,
    role: 'assistant',
    kind: 'tool_call',
    tool,
    tool_call_id: id,
    content: JSON.stringify({ role: 'assistant', tool_calls: [{ id, type: 'function', function: { name: tool, arguments: JSON.stringify(args) } }] }),
  });
}

function toolResult(id: string, tool: string, result: unknown): AgentMessage {
  return msg({ id: `result-${id}`, role: 'tool', kind: 'tool_result', tool, tool_call_id: id, content: JSON.stringify(result) });
}

function marker(id: string): AgentMessage {
  return msg({ id, role: 'system', kind: 'activity', content: JSON.stringify({ event: 'activation_open', role: 'planner', card_id: 'card-1', input_id: id, timestamp }) });
}

function positioned(id: string, start: number, end: number): PositionedMessage {
  return { message: msg({ id, role: 'user', kind: 'text', content: id }), estimated_tokens: end - start, start_token: start, end_token: end };
}

function round(id: string, start: number, end: number): ClassifiedRound {
  const row = positioned(id, start, end);
  return { round_id: id, activation_marker: row, rows: [row], sub_rounds: [], start_token: start, end_token: end };
}

function withRoot<T>(fn: (root: string) => T): T {
  const root = mkdtempSync(join(tmpdir(), 'saivage-compaction-'));
  try { return fn(root); } finally { rmSync(root, { recursive: true, force: true }); }
}

describe('compaction primitives', () => {
  it('classifies activation rounds, persisted sub-round boundaries, existing compacted rows, and cumulative positions', () => {
    const rows = [
      msg({ id: 'system', role: 'system', kind: 'text', content: 'system prompt' }),
      msg({ id: 'old-summary', role: 'user', kind: 'context_compaction', content: '[Compacted prior conversation — generation 1]:\nsummary' }),
      marker('activation-1'),
      msg({ id: 'ordinary-text', role: 'user', kind: 'text', content: 'persisted rework directive is ordinary content' }),
      toolResult('terminal', 'emit_result', { success: false, error: 'Reviewer requested rework at record:///card-1/review.md?x=1. Reviewer summary: fix it' }),
      msg({ id: 'repair', role: 'user', kind: 'model_repair', content: 'repair malformed tool call' }),
      marker('activation-2'),
      toolResult('grep1', 'grep', { success: false, error: 'missing pattern' }),
    ];

    const classified = classifyConversationRounds(rows);

    expect(classified.preamble.map((row) => row.message.id)).toEqual(['system']);
    expect(classified.already_compacted_history.map((row) => row.message.id)).toEqual(['old-summary']);
    expect(classified.rounds).toHaveLength(2);
    expect(classified.rounds[0].activation_marker.message.id).toBe('activation-1');
    expect(classified.rounds[0].sub_rounds.map((sub) => sub.kind)).toEqual(['reviewer_rework', 'repair']);
    expect(classified.rounds[1].sub_rounds.map((sub) => sub.kind)).toEqual(['repair']);
    expect(classified.total_estimated_tokens).toBeGreaterThan(0);
    for (const round of classified.rounds) expect(round.end_token).toBeGreaterThan(round.start_token);
  });

  it('snaps bands according to keep-straddler and compact-straddler policies', () => {
    const rounds = [round('r1', 0, 20), round('r2', 20, 55), round('r3', 55, 85)];
    const base = { total_estimated_tokens: 85, rounds, config: { buffer_tokens: 100, merge_line_fraction: 0.2, summary_line_fraction: 0.5, trigger_fraction: 0.8, snap: 'keep_straddler_verbatim' as const } };

    const keep = computeCompactionBands(base);
    expect(keep.snapped_boundaries.summary_line).toBe(20);
    expect(keep.summary_rounds.map((r) => r.round_id)).toEqual([]);
    expect(keep.tail_rounds.map((r) => r.round_id)).toEqual(['r2', 'r3']);

    const compact = computeCompactionBands({ ...base, config: { ...base.config, snap: 'compact_straddler' } });
    expect(compact.snapped_boundaries.summary_line).toBe(55);
    expect(compact.summary_rounds.map((r) => r.round_id)).toEqual(['r2']);
    expect(compact.tail_rounds.map((r) => r.round_id)).toEqual(['r3']);
  });

  it('drops recoverable tool-result bodies on copies while preserving recovery pointers and deterministic descriptors', () => {
    const rows = [
      toolCall('read1', 'read', { path: 'src/main.ts' }),
      toolResult('read1', 'read', { success: true, data: { content: 'large source body' } }),
      toolCall('web1', 'webfetch', { url: 'https://example.com/big' }),
      toolResult('web1', 'webfetch', { success: true, data: { stash_url: 'work:///tmp/stash/webfetch-1.txt', bytes: 4200, text: 'large web body' } }),
      toolCall('proc1', 'run_command', { command: 'pytest tests/foo' }),
      toolResult('proc1', 'run_command', { success: true, data: { stdout_url: 'work:///processes/p-1/stdout.log', stderr_url: 'work:///processes/p-1/stderr.log', stdout_bytes: 12000, stderr_bytes: 300 } }),
    ];

    const descriptors = recoverableEvidenceDescriptors(rows);
    const dropped = dropRecoverableResultBodies(rows);

    expect(dropped).not.toBe(rows);
    expect(rows[1].content).toContain('large source body');
    expect(dropped[1].content).not.toContain('large source body');
    expect(dropped[3].content).toContain('work:///tmp/stash/webfetch-1.txt');
    expect(dropped[5].content).toContain('work:///processes/p-1/stdout.log');
    expect(dropped[5].content).not.toContain('large stdout');
    expect(descriptors).toEqual([
      { flavor: 'source_recallable', tool: 'read', args: { path: 'src/main.ts' }, label: 'src/main.ts' },
      { flavor: 'stash', url: 'work:///tmp/stash/webfetch-1.txt', label: 'webfetch of https://example.com/big', bytes: 4200 },
      { flavor: 'process_stdout', url: 'work:///processes/p-1/stdout.log', label: 'pytest tests/foo', bytes: 12000 },
      { flavor: 'process_stderr', url: 'work:///processes/p-1/stderr.log', label: 'pytest tests/foo', bytes: 300 },
    ]);
  });

  it('stores immutable summary cache entries and renders deterministic recoverable evidence markdown', () => withRoot((root) => {
    const sessionId = 'analyst:global';
    const source = [msg({ id: 'source-1', role: 'user', kind: 'text', content: 'raw round' })];
    const contentHash = contentHashForMessages(source);
    const cacheKey = summaryCacheKey('activation-1', contentHash);
    appendTestConversationMessage(root, { ...source[0]!, session_id: sessionId });
    const entry = appendSummaryCacheEntry(root, sessionId, {
      cache_key: cacheKey,
      round_id: 'activation-1',
      content_hash: contentHash,
      summary_text: 'The model inspected source.',
      recoverable_evidence: [{ flavor: 'source_recallable', tool: 'read', args: { path: 'b', z: 1, a: 2 }, label: 'b' }],
      provenance: { source_message_ids: ['source-1'] },
      created_at: timestamp,
    });

    expect(() => appendSummaryCacheEntry(root, sessionId, entry)).toThrow(/already exists/);
    expect(() => appendSummaryCacheEntry(root, sessionId, { ...entry, summary_text: 'changed' })).toThrow(/already exists/);
    expect(renderRecoverableEvidenceSection(entry.recoverable_evidence as RecoverableEvidenceDescriptor[])).toBe('## Recoverable evidence (use `read` to recover full content)\n\n- **source_recallable** `read` args `{"a":2,"path":"b","z":1}` — b');
  }));

  it('summarizer APIs reject existing summary rows and keep pointer sections out of provider output', async () => {
    const calls: unknown[] = [];
    const provider: SummarizerProviderPort = {
      async completeTurn(input, signal) {
        calls.push({ input, signal });
        return { result: { kind: 'message', content: 'Plain prose summary.' }, provider_exchanges: [] };
      },
    };
    await expect(summarizeRound({ round_id: 'round-1', rows: [msg({ id: 'raw', role: 'user', kind: 'text', content: 'raw' })], summarizerProvider: provider, modelSpec: 'cheap-model', signal: new AbortController().signal })).resolves.toBe('Plain prose summary.');
    await expect(summarizeRound({ round_id: 'round-2', rows: [msg({ id: 'summary', role: 'user', kind: 'context_compaction', content: 'old summary' })], summarizerProvider: provider, modelSpec: 'cheap-model', signal: new AbortController().signal })).rejects.toThrow(/context_compaction/);
    await expect(summarizeMerge({ entries: [{ cache_key: 'k', round_id: 'r', content_hash: 'h', summary_text: 'Cached prose.', recoverable_evidence: [{ flavor: 'stash', url: 'work:///tmp/stash/a', label: 'stash' }], provenance: { source_message_ids: [] }, created_at: timestamp }], summarizerProvider: provider, modelSpec: 'cheap-model', signal: new AbortController().signal })).resolves.toBe('Plain prose summary.');

    expect(JSON.stringify(calls)).not.toContain('Recoverable evidence');
    expect(JSON.stringify(calls)).not.toContain('work:///tmp/stash/a');
  });
});
