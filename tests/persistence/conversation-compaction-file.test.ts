import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, jest } from '@jest/globals';

import { appendConversationBatch, readConversation, readConversationCatalog, readCurrentConversationSegment, readHistoricalConversationSegment } from '../../src/persistence/conversation-file.js';
import { compact, prepareCompaction, type AutonomousCompactionPolicy } from '../../src/runtime/actors/compaction/compactor.js';
import { buildGlobalAgentIngressRows, providerConversationProjection } from '../../src/runtime/actors/conversation-session.js';
import type { PreparedLlmInvocationInput } from '../../src/runtime/actors/llm-invocation.js';
import { buildPreparedInvocationContext } from '../../src/runtime/actors/context/context-blocks.js';
import type { ProviderConversationItem } from '../../src/contracts/index.js';
import type { AgentMessage } from '../../src/schemas/index.js';
import { initProjectTree } from '../helpers/canonical-project.js';
import { deterministicSummarySerialization } from '../helpers/summary-serialization.js';
import { noCompactionProgress } from '../helpers/executing-llm-snapshot.js';
import { ACTIVITY_ROW_POLICY, TEXT_ROW_POLICY } from '../helpers/row-policy-fixtures.js';
import { cardConversationVersionFile } from '../../src/persistence/layout.js';

const SESSION = 'agent:planner:project' as const;
const CANDIDATE = { provider: 'test', account: null, model: 'test' } as const;
const POLICY: AutonomousCompactionPolicy = { context_utilization_fraction: 0.8, trigger_fraction: 0.8, tail_fraction: 0.25, snap: 'compact_straddler' };

describe('conversation compaction file persistence', () => {
  it('publishes one immutable successor and retains the predecessor as explicit history', async () => {
    const root = mkdtempSync(join(tmpdir(), 'conversation-compaction-file-')); initProjectTree(root);
    try {
      for (let ordinal = 1; ordinal <= 7; ordinal++) appendConversationBatch({ projectRoot: root }, round(ordinal));
      const current = readCurrentConversationSegment(root, SESSION)!;
      const result = await compact({ strategy: 'preventive', conversations: { projectRoot: root }, input: invocation(providerConversationProjection(current.conversation, []).messages), summarizerProvider: { candidate: CANDIDATE, contextWindowTokens: 100_000, maxOutputTokens: 10_000, serializeSummaryRequest: deterministicSummarySerialization, completeTurn: async () => ({ result: { kind: 'message' as const, content: 'summary' }, provider_exchanges: [] }), projectProviderExchanges: jest.fn() }, signal: new AbortController().signal, progress: noCompactionProgress });
      expect(result.kind).toBe('compacted');
      expect(readConversationCatalog(root, SESSION).versions.map(({ version }) => version)).toEqual([1, 2]);
      expect(readCurrentConversationSegment(root, SESSION)!.genesis.kind).toBe('compacted_segment_genesis');
      expect(readHistoricalConversationSegment(root, SESSION, 1).genesis.kind).toBe('ordinary_segment_genesis');
      expect(readCurrentConversationSegment(root, SESSION)!.rows.some((row) => row.kind === ('context_compaction' as never))).toBe(false);
      const predecessorPath = cardConversationVersionFile(root, 'project', 'planner', current.entry.filename);
      appendFileSync(predecessorPath, 'torn immutable suffix'); const immutable = readFileSync(predecessorPath);
      expect(() => readHistoricalConversationSegment(root, SESSION, 1)).toThrow(); expect(readFileSync(predecessorPath)).toEqual(immutable);
      const successor = readCurrentConversationSegment(root, SESSION)!;
      const successorPath = cardConversationVersionFile(root, 'project', 'planner', successor.entry.filename);
      appendFileSync(successorPath, 'torn current suffix');
      expect(readHistoricalConversationSegment(root, SESSION, 2).bytes).toEqual(successor.bytes); expect(readFileSync(successorPath)).toEqual(successor.bytes);
      const envelopes = successor.bytes.toString().trimEnd().split('\n').map((line) => JSON.parse(line));
      envelopes[0].rows[0].source.sha256 = '0'.repeat(64);
      const invalid = Buffer.from(`${envelopes.map((envelope) => JSON.stringify(envelope)).join('\n')}\nsuffix`); writeFileSync(successorPath, invalid);
      expect(() => readCurrentConversationSegment(root, SESSION)).toThrow(/commitment/); expect(readFileSync(successorPath)).toEqual(invalid);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('compacts retained Analyst system-text history alongside the new two-row source without rewriting the old row', async () => {
    const root = mkdtempSync(join(tmpdir(), 'analyst-retained-compaction-')); initProjectTree(root);
    const analyst = 'agent:analyst:global' as const;
    try {
      for (let ordinal = 1; ordinal <= 7; ordinal++) {
        const inputId = `00000000-0000-4000-8000-${String(ordinal).padStart(12, '0')}`;
        const ingress = buildGlobalAgentIngressRows(analyst, inputId, `question ${ordinal} ${'x'.repeat(400)}`);
        if (ordinal === 1) {
          const oldNote = { ...ingress[1], role: 'system' as const, id: 'retained-workspace-note', content: '[workspace-context] old focus', round_id: ingress[0].round_id, message_index: 0, block_index: 1 };
          appendConversationBatch({ projectRoot: root }, [ingress[0], oldNote, ingress[1]]);
        } else appendConversationBatch({ projectRoot: root }, ingress);
      }
      const before = readCurrentConversationSegment(root, analyst)!;
      const result = await compact({ strategy: 'preventive', conversations: { projectRoot: root }, input: invocation(providerConversationProjection(before.conversation, []).messages, analyst), summarizerProvider: { candidate: CANDIDATE, contextWindowTokens: 100_000, maxOutputTokens: 10_000, serializeSummaryRequest: deterministicSummarySerialization, completeTurn: async () => ({ result: { kind: 'message' as const, content: 'historical summary' }, provider_exchanges: [] }), projectProviderExchanges: jest.fn() }, signal: new AbortController().signal, progress: noCompactionProgress });
      expect(result.kind).toBe('compacted');
      expect(readHistoricalConversationSegment(root, analyst, 1).rows.some((row) => row.content === '[workspace-context] old focus')).toBe(true);
      expect(readCurrentConversationSegment(root, analyst)!.genesis.kind).toBe('compacted_segment_genesis');
      appendConversationBatch({ projectRoot: root }, buildGlobalAgentIngressRows(analyst, '00000000-0000-4000-8000-000000000008', 'question after compacted history'));
      expect(readConversation(root, analyst).sourceRows.some((row) => row.content === 'question after compacted history')).toBe(true);
      expect(readHistoricalConversationSegment(root, analyst, 1).rows.some((row) => row.content === '[workspace-context] old focus')).toBe(true);
      expect(readConversation(root, analyst).sourceRows.some((row) => row.content.includes('workspace_focus'))).toBe(false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

function round(ordinal: number): AgentMessage[] { const timestamp = `2026-08-11T00:${String(ordinal).padStart(2, '0')}:00.000Z`; return [{ id: `activation-${ordinal}`, session_id: SESSION, role: 'system', kind: 'activity', context_policy: ACTIVITY_ROW_POLICY, content: JSON.stringify({ event: 'activation_open', agent_name: 'planner', card_id: 'project', input_id: `00000000-0000-4000-8000-${String(ordinal).padStart(12, '0')}`, timestamp }), round_id: `r-pre-${String(ordinal).padStart(32, '0')}`, message_index: 0, block_index: 0, timestamp }, { id: `message-${ordinal}`, session_id: SESSION, role: 'user', kind: 'text', context_policy: TEXT_ROW_POLICY, content: 'x'.repeat(400), round_id: `r-user-${String(ordinal).padStart(32, '0')}`, message_index: 1, block_index: 0, timestamp }]; }
function invocation(messages: readonly ProviderConversationItem[], sessionId: typeof SESSION | 'agent:analyst:global' = SESSION): PreparedLlmInvocationInput { const preparedCompaction = prepareCompaction(POLICY, 'system', [], 8_000, 2_000); return { inputId: '00000000-0000-4000-8000-000000000001', agentId: sessionId, agentName: sessionId === SESSION ? 'planner' : 'analyst', sessionId, systemPrompt: 'system', providerConversation: { sourceSessionId: sessionId, messages: [...messages] }, tools: [], compiledToolContracts: [], terminalToolNames: [], modelParams: { temperature: 0 }, preparedCompaction, preparedContext: buildPreparedInvocationContext({ instructionText: 'system', terminalToolNames: [], compiledTools: [], dynamicBlocks: [], preparedCompaction }), capabilityRequest: {}, routePass: { kind: 'ordinary', candidateChain: [CANDIDATE] }, episodeContext: {} }; }
