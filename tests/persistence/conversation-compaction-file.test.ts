import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, jest } from '@jest/globals';

import { appendConversationBatch, readConversationCatalog, readCurrentConversationSegment, readHistoricalConversationSegment } from '../../src/persistence/conversation-file.js';
import { compact, prepareCompaction, type AutonomousCompactionPolicy } from '../../src/runtime/actors/compaction/compactor.js';
import { providerConversationProjection } from '../../src/runtime/actors/conversation-session.js';
import type { PreparedLlmInvocationInput } from '../../src/runtime/actors/llm-invocation.js';
import { buildPreparedInvocationContext } from '../../src/runtime/actors/context/context-blocks.js';
import type { AgentMessage } from '../../src/schemas/index.js';
import { initProjectTree } from '../helpers/canonical-project.js';
import { ACTIVITY_ROW_POLICY, TEXT_ROW_POLICY } from '../helpers/row-policy-fixtures.js';

const SESSION = 'agent:planner:project' as const;
const CANDIDATE = { provider: 'test', account: null, model: 'test' } as const;
const POLICY: AutonomousCompactionPolicy = { input_budget_tokens: 1000, trigger_fraction: 0.8, completion_reserve_fraction: 0.2, merge_line_fraction: 0.3, summary_line_fraction: 0.5, escalate_merge_line_fraction: 0.4, escalate_summary_line_fraction: 0.55, snap: 'compact_straddler' };

describe('conversation compaction file persistence', () => {
  it('publishes one immutable successor and retains the predecessor as explicit history', async () => {
    const root = mkdtempSync(join(tmpdir(), 'conversation-compaction-file-')); initProjectTree(root);
    try {
      for (let ordinal = 1; ordinal <= 7; ordinal++) appendConversationBatch({ projectRoot: root }, round(ordinal));
      const current = readCurrentConversationSegment(root, SESSION)!;
      const result = await compact({ strategy: 'preventive', conversations: { projectRoot: root }, input: invocation(providerConversationProjection(current.conversation).messages), summarizerProvider: { candidate: CANDIDATE, completeTurn: async () => ({ result: { kind: 'message' as const, content: 'summary' }, provider_exchanges: [] }), projectProviderExchanges: jest.fn() }, signal: new AbortController().signal });
      expect(result.kind).toBe('compacted');
      expect(readConversationCatalog(root, SESSION).versions.map(({ version }) => version)).toEqual([1, 2]);
      expect(readCurrentConversationSegment(root, SESSION)!.genesis.kind).toBe('compacted_segment_genesis');
      expect(readHistoricalConversationSegment(root, SESSION, 1).genesis.kind).toBe('ordinary_segment_genesis');
      expect(readCurrentConversationSegment(root, SESSION)!.rows.some((row) => row.kind === ('context_compaction' as never))).toBe(false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

function round(ordinal: number): AgentMessage[] { const timestamp = `2026-08-11T00:${String(ordinal).padStart(2, '0')}:00.000Z`; return [{ id: `activation-${ordinal}`, session_id: SESSION, role: 'system', kind: 'activity', context_policy: ACTIVITY_ROW_POLICY, content: JSON.stringify({ event: 'activation_open', agent_name: 'planner', card_id: 'project', input_id: `00000000-0000-4000-8000-${String(ordinal).padStart(12, '0')}`, timestamp }), round_id: `r-pre-${String(ordinal).padStart(32, '0')}`, message_index: 0, block_index: 0, timestamp }, { id: `message-${ordinal}`, session_id: SESSION, role: 'user', kind: 'text', context_policy: TEXT_ROW_POLICY, content: 'x'.repeat(400), round_id: `r-user-${String(ordinal).padStart(32, '0')}`, message_index: 1, block_index: 0, timestamp }]; }
function invocation(messages: readonly AgentMessage[]): PreparedLlmInvocationInput { const preparedCompaction = prepareCompaction(POLICY, 'system', []); return { inputId: '00000000-0000-4000-8000-000000000001', agentId: SESSION, agentName: 'planner', sessionId: SESSION, systemPrompt: 'system', providerConversation: { sourceSessionId: SESSION, messages: [...messages] }, tools: [], compiledToolContracts: [], terminalToolNames: [], modelParams: { temperature: 0 }, preparedCompaction, preparedContext: buildPreparedInvocationContext({ instructionText: 'system', terminalToolNames: [], compiledTools: [], dynamicBlocks: [], preparedCompaction }), capabilityRequest: {}, routePass: { kind: 'ordinary', candidateChain: [CANDIDATE] }, episodeContext: {} }; }
