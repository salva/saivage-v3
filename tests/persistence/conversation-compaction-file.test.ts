import { appendFileSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, jest } from '@jest/globals';

import { appendConversationBatch, inspectConversationIndex, inspectConversationSegment, readConversation, readConversationCatalog, readCurrentConversationSegment, readHistoricalConversationSegment } from '../../src/persistence/conversation-file.js';
import { compact, prepareCompaction, type AutonomousCompactionPolicy } from '../../src/runtime/actors/compaction/compactor.js';
import { buildGlobalAgentIngressRows, providerConversationProjection } from '../../src/runtime/actors/conversation-session.js';
import type { PreparedLlmInvocationInput } from '../../src/runtime/actors/llm-invocation.js';
import { buildPreparedInvocationContext } from '../../src/runtime/actors/context/context-blocks.js';
import type { ProviderConversationItem } from '../../src/contracts/index.js';
import type { AgentMessage } from '../../src/schemas/index.js';
import { initProjectTree, TEST_WORKFLOWS } from '../helpers/canonical-project.js';
import { inspectRepairTarget } from '../../src/persistence/repair-target.js';
import { deterministicSummarySerialization } from '../helpers/summary-serialization.js';
import { noCompactionProgress } from '../helpers/executing-llm-snapshot.js';
import { ACTIVITY_ROW_POLICY, TEXT_ROW_POLICY } from '../helpers/row-policy-fixtures.js';
import { cardConversationVersionFile, cardConversationVersionIndexFile, conversationPreviousIndexFile } from '../../src/persistence/layout.js';
import { RESPONSES_A, RESPONSES_B, responsesBundle } from '../helpers/responses-producer-fixture.js';
import { responsesProducerAccountId } from '../../src/agents/llm-openai-responses-account.js';
import { responsesInputFromProviderConversation } from '../../src/agents/llm-openai-responses-mapper.js';

const SESSION = 'agent:planner:project' as const;
const CANDIDATE = { provider: 'test', account: null, model: 'test' } as const;
const POLICY: AutonomousCompactionPolicy = { context_utilization_fraction: 0.8, trigger_fraction: 0.8, tail_fraction: 0.25, snap: 'compact_straddler' };

describe('conversation compaction file persistence', () => {
  it('repairs only one indexed newest-segment rollback, preserving the wholly valid predecessor bytes', async () => {
    const root=mkdtempSync(join(tmpdir(),'conversation-exact-rollback-')); initProjectTree(root);
    try {
      for(let ordinal=1;ordinal<=7;ordinal++)appendConversationBatch({projectRoot:root},round(ordinal));
      const original=readCurrentConversationSegment(root,SESSION)!;
      const originalBytes = readFileSync(cardConversationVersionFile(root, 'project', 'planner', original.entry.filename));
      const result=await compact({strategy:'preventive',conversations:{projectRoot:root},input:invocation(providerConversationProjection(original.conversation,[]).messages),summarizerProvider:{materializeImage: async () => { throw new Error('Unexpected image.'); },candidate:CANDIDATE,contextWindowTokens:100_000,maxOutputTokens:10_000,serializeSummaryRequest:deterministicSummarySerialization,completeTurn:async()=>({result:{kind:'message' as const,content:'summary'},provider_exchanges:[]}),projectProviderExchanges:jest.fn()},signal:new AbortController().signal,progress:noCompactionProgress});
      expect(result.kind).toBe('compacted'); const newest=readCurrentConversationSegment(root,SESSION)!;
      const path=cardConversationVersionFile(root,'project','planner',newest.entry.filename); writeFileSync(path,'{complete malformed}\n');
      const decision=inspectRepairTarget(root,TEST_WORKFLOWS,{kind:'conversation',sessionId:SESSION});
      expect(decision.summary.join('\n')).toContain('potentially days-long'); expect(decision.steps.map(step=>step.description)).toEqual([expect.stringContaining('immediate wholly valid'),expect.stringContaining('Move exact corrupt')]);
      decision.recheck(); for(const step of decision.steps)step.apply(); decision.validate();
      expect(readCurrentConversationSegment(root,SESSION)!.rows).toEqual(original.rows); expect(readFileSync(cardConversationVersionFile(root, 'project', 'planner', original.entry.filename))).toEqual(originalBytes); expect(readConversationCatalog(root,SESSION).currentVersion).toBe(1);
    } finally {rmSync(root,{recursive:true,force:true});}
  });
  it('compacts a covered private bundle while preserving the exact mixed A/B retained tail and visible-only summary source', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mixed-producer-compaction-')); initProjectTree(root);
    try {
      const old = responsesBundle(SESSION, '00000000-0000-4000-8000-000000000011', RESPONSES_A, '{"success":true,"data":"old-tool"}');
      const tail = [...responsesBundle(SESSION, '00000000-0000-4000-8000-000000000012', RESPONSES_A, '{"success":true,"data":"tail-a"}'), ...responsesBundle(SESSION, '00000000-0000-4000-8000-000000000013', RESPONSES_B, '{"success":false,"error":"tail-b"}')];
      for (let ordinal = 1; ordinal <= 7; ordinal++) appendConversationBatch({ projectRoot: root }, [...round(ordinal).map(row => ordinal === 1 && row.kind === 'text' ? { ...row, content: 'x'.repeat(12_000) } : row), ...(ordinal === 1 ? old : ordinal === 7 ? tail : [])]);
      appendConversationBatch({ projectRoot: root }, [round(8)[0]!]);
      const before = readCurrentConversationSegment(root, SESSION)!;
      const source: string[] = [];
      const result = await compact({ strategy: 'preventive', conversations: { projectRoot: root }, input: invocation(providerConversationProjection(before.conversation, []).messages), summarizerProvider: { materializeImage: async () => { throw new Error('Unexpected image.'); }, candidate: CANDIDATE, contextWindowTokens: 100_000, maxOutputTokens: 10_000, serializeSummaryRequest: deterministicSummarySerialization, completeTurn: async input => { source.push(JSON.stringify(input.providerConversation)); return { result: { kind: 'message' as const, content: 'visible summary' }, provider_exchanges: [] }; }, projectProviderExchanges: jest.fn() }, signal: new AbortController().signal, progress: noCompactionProgress });
      expect(result.kind).toBe('compacted');
      const successor = readCurrentConversationSegment(root, SESSION)!;
      expect(successor.rows.filter(row => row.kind === 'provider_private')).toEqual(tail.filter(row => row.kind === 'provider_private'));
      expect(successor.rows.some(row => row.id === old[0]!.id)).toBe(false);
      expect(readHistoricalConversationSegment(root, SESSION, 1).rows.filter(row => row.kind === 'provider_private')).toEqual([...old, ...tail].filter(row => row.kind === 'provider_private'));
      expect(source.join('')).toContain('old-tool');
      expect(source.join('')).not.toContain('producer_account_id');
      expect(source.join('')).not.toContain('ciphertext-');
      for (const candidate of [RESPONSES_A, RESPONSES_B]) {
        const input = responsesInputFromProviderConversation(providerConversationProjection(successor.conversation, []), responsesProducerAccountId(candidate));
        const serialized = JSON.stringify(input);
        expect(serialized.includes('ciphertext-00000000-0000-4000-8000-000000000012')).toBe(candidate === RESPONSES_A);
        expect(serialized.includes('ciphertext-00000000-0000-4000-8000-000000000013')).toBe(candidate === RESPONSES_B);
        expect(serialized).toContain('tail-a'); expect(serialized).toContain('tail-b');
      }
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it('publishes one immutable successor and retains the predecessor as explicit history', async () => {
    const root = mkdtempSync(join(tmpdir(), 'conversation-compaction-file-')); initProjectTree(root);
    try {
      for (let ordinal = 1; ordinal <= 7; ordinal++) appendConversationBatch({ projectRoot: root }, round(ordinal));
      const current = readCurrentConversationSegment(root, SESSION)!;
      const currentBytes = readFileSync(cardConversationVersionFile(root, 'project', 'planner', current.entry.filename));
      const result = await compact({ strategy: 'preventive', conversations: { projectRoot: root }, input: invocation(providerConversationProjection(current.conversation, []).messages), summarizerProvider: { materializeImage: async () => { throw new Error('Unexpected image.'); }, candidate: CANDIDATE, contextWindowTokens: 100_000, maxOutputTokens: 10_000, serializeSummaryRequest: deterministicSummarySerialization, completeTurn: async () => ({ result: { kind: 'message' as const, content: 'summary' }, provider_exchanges: [] }), projectProviderExchanges: jest.fn() }, signal: new AbortController().signal, progress: noCompactionProgress });
      expect(result.kind).toBe('compacted');
      expect(readConversationCatalog(root, SESSION).versions.map(({ version }) => version)).toEqual([1, 2]);
      expect(readCurrentConversationSegment(root, SESSION)!.genesis.kind).toBe('compacted_segment_genesis');
      expect(readHistoricalConversationSegment(root, SESSION, 1).genesis.kind).toBe('ordinary_segment_genesis');
      expect(readCurrentConversationSegment(root, SESSION)!.rows.some((row) => row.kind === ('context_compaction' as never))).toBe(false);
      const predecessorPath = cardConversationVersionFile(root, 'project', 'planner', current.entry.filename);
      appendFileSync(predecessorPath, 'torn immutable suffix'); const immutable = readFileSync(predecessorPath);
      const indexPath = cardConversationVersionIndexFile(root, 'project', 'planner');
      const index = inspectConversationIndex(root, SESSION, readFileSync(indexPath));
      // Rollback eligibility examines the predecessor while it is still immutable history.
      expect(() => inspectConversationSegment(root, SESSION, index, 1)).toThrow(/incomplete/);
      // Previous-index restoration may report restore-then-truncate of its selected current body.
      const previous = inspectConversationIndex(root, SESSION, readFileSync(conversationPreviousIndexFile(indexPath)));
      const candidate = inspectConversationSegment(root, SESSION, previous)!;
      expect(candidate.retainedLength).toBe(currentBytes.length);
      expect(candidate.bytes).toEqual(immutable);
      expect(candidate.projection).not.toHaveProperty('bytes');
      expect(candidate.tornSuffixLength).toBe(Buffer.byteLength('torn immutable suffix'));
      expect(candidate.projection.entry.version).toBe(1);
      expect(readFileSync(predecessorPath)).toEqual(immutable);
      expect(() => readHistoricalConversationSegment(root, SESSION, 1)).toThrow(); expect(readFileSync(predecessorPath)).toEqual(immutable);
      const successor = readCurrentConversationSegment(root, SESSION)!;
      const successorPath = cardConversationVersionFile(root, 'project', 'planner', successor.entry.filename);
      const successorBytes = readFileSync(successorPath);
      appendFileSync(successorPath, 'torn current suffix');
      expect(readHistoricalConversationSegment(root, SESSION, 2).rows).toEqual(successor.rows); expect(readFileSync(successorPath)).toEqual(successorBytes);
      const envelopes = successorBytes.toString().trimEnd().split('\n').map((line) => JSON.parse(line));
      envelopes[0].rows[0].source.covered_through_message_id = 'wrong-cutoff';
      const invalid = Buffer.from(`${envelopes.map((envelope) => JSON.stringify(envelope)).join('\n')}\nsuffix`); writeFileSync(successorPath, invalid);
      expect(() => inspectConversationSegment(root, SESSION, index)).toThrow(/metadata/);
      expect(() => readCurrentConversationSegment(root, SESSION)).toThrow(/metadata/); expect(readFileSync(successorPath)).toEqual(invalid);
      // A corrupt current segment never qualifies an also-torn historical predecessor.
      expect(() => inspectRepairTarget(root,TEST_WORKFLOWS,{kind:'conversation',sessionId:SESSION})).toThrow(/incomplete/);
      expect(readFileSync(predecessorPath)).toEqual(immutable);
      // Exact previous-index restoration can instead report restore-then-truncate.
      unlinkSync(indexPath); writeFileSync(indexPath,'broken index');
      const restoration=inspectRepairTarget(root,TEST_WORKFLOWS,{kind:'conversation',sessionId:SESSION});
      expect(restoration.steps.map(step=>step.description)).toEqual([expect.stringContaining('Move exact corrupt'),expect.stringContaining('Fresh-publish'),expect.stringContaining('Truncate only')]);
      expect(readFileSync(predecessorPath)).toEqual(immutable); expect(readFileSync(indexPath,'utf8')).toBe('broken index');
      restoration.recheck(); for(const step of restoration.steps)step.apply(); restoration.validate();
      expect(readCurrentConversationSegment(root,SESSION)!.entry.version).toBe(1); expect(readFileSync(predecessorPath)).toEqual(currentBytes); expect(readFileSync(successorPath)).toEqual(invalid);
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
      const result = await compact({ strategy: 'preventive', conversations: { projectRoot: root }, input: invocation(providerConversationProjection(before.conversation, []).messages, analyst), summarizerProvider: { materializeImage: async () => { throw new Error('Unexpected image.'); }, candidate: CANDIDATE, contextWindowTokens: 100_000, maxOutputTokens: 10_000, serializeSummaryRequest: deterministicSummarySerialization, completeTurn: async () => ({ result: { kind: 'message' as const, content: 'historical summary' }, provider_exchanges: [] }), projectProviderExchanges: jest.fn() }, signal: new AbortController().signal, progress: noCompactionProgress });
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
