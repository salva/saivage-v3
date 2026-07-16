import { describe, expect, it, jest } from '@jest/globals';
import type { AgentMessage } from '../../../src/schemas/index.js';
import { dropRecoverableResultBodies, recoverableEvidenceDescriptors } from '../../../src/runtime/actors/compaction/result-dropping.js';
import { classifyConversationRounds } from '../../../src/runtime/actors/compaction/round-classifier.js';
import { summarizeMerge, summarizeRound, type SummarizerProviderPort } from '../../../src/runtime/actors/compaction/summarizer.js';

const timestamp = '2026-07-15T00:00:00.000Z';
const msg = (partial: Partial<AgentMessage> & Pick<AgentMessage, 'id' | 'kind' | 'role' | 'content'>): AgentMessage => ({ session_id: 'planner:project', round_id: 'r-user-00000000000000000000000000000000', message_index: 0, block_index: 0, timestamp, ...partial });

describe('raw-authoritative compaction primitives', () => {
  it('excludes metadata from source classification and uses only repair segment kinds', () => {
    const rows = [
      msg({ id: 'static', role: 'system', kind: 'text', content: 'static' }),
      msg({ id: 'activation', role: 'system', kind: 'activity', content: JSON.stringify({ event: 'activation_open' }) }),
      msg({ id: 'failed', role: 'tool', kind: 'tool_result', tool: 'emit_result', tool_call_id: 'call', content: JSON.stringify({ success: false, error: 'Reviewer requested rework' }) }),
      msg({ id: 'repair', role: 'user', kind: 'model_repair', content: 'repair' }),
    ];
    const classified = classifyConversationRounds(rows);
    expect(classified.preamble.map((row) => row.message.id)).toEqual(['static']);
    expect(classified.rounds[0]!.sub_rounds.map((segment) => segment.kind)).toEqual(['repair', 'repair']);
  });

  it('drops recoverable raw result bodies while retaining descriptors', () => {
    const call = msg({ id: '00000000-0000-4000-8000-000000000001:tool-call:read-1', role: 'assistant', kind: 'tool_call', tool: 'read', tool_call_id: 'read-1', content: JSON.stringify({ tool_calls: [{ function: { arguments: JSON.stringify({ path: 'src/a.ts' }) } }] }) });
    const result = msg({ id: '00000000-0000-4000-8000-000000000001:tool-result:read-1', role: 'tool', kind: 'tool_result', tool: 'read', tool_call_id: 'read-1', content: JSON.stringify({ success: true, data: { content: 'large body' } }) });
    expect(dropRecoverableResultBodies([call, result])[1]!.content).not.toContain('large body');
    expect(recoverableEvidenceDescriptors([call, result])).toEqual([{ flavor: 'source_recallable', tool: 'read', args: { path: 'src/a.ts' }, label: 'src/a.ts' }]);
  });

  it('summarizes only raw rows and merges ordered summary prose without cache contracts', async () => {
    const completeTurn = jest.fn(async () => ({ result: { kind: 'message' as const, content: 'summary' }, provider_exchanges: [] }));
    const provider: SummarizerProviderPort = { completeTurn };
    await expect(summarizeRound({ round_id: 'round', rows: [msg({ id: 'raw', role: 'user', kind: 'text', content: 'raw' })], summarizerProvider: provider, modelSpec: 'test', signal: new AbortController().signal })).resolves.toBe('summary');
    await expect(summarizeMerge({ entries: [{ round_id: 'round', summary_text: 'raw-derived summary' }], summarizerProvider: provider, modelSpec: 'test', signal: new AbortController().signal })).resolves.toBe('summary');
    expect(JSON.stringify(completeTurn.mock.calls)).toContain('raw-derived summary');
  });
});
