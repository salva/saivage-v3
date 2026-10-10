import { mkdtempSync, rmSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, jest } from '@jest/globals';

import { compact, LOCAL_OMISSION_SUMMARY, prepareCompaction, type AutonomousCompactionPolicy, type CompactionStrategy } from '../../../../src/runtime/actors/compaction/compactor.js';
import { estimateMessageTokens } from '../../../../src/runtime/actors/compaction/round-classifier.js';
import { providerConversationProjection } from '../../../../src/runtime/actors/conversation-session.js';
import { buildPreparedInvocationContext } from '../../../../src/runtime/actors/context/context-blocks.js';
import type { PreparedLlmInvocationInput } from '../../../../src/runtime/actors/llm-invocation.js';
import { appendConversationBatch, readConversation, readConversationCatalog, readCurrentConversationSegment } from '../../../../src/persistence/conversation-file.js';
import { cardConversationVersionFile } from '../../../../src/persistence/layout.js';
import { validateCompactedHistorySuccessor, type ValidatedConversation } from '../../../../src/contracts/conversation-validation.js';
import { canonicalJson, type AgentMessage } from '../../../../src/schemas/index.js';
import { SummaryPolicyRefusalError, type SummarizerProviderPort } from '../../../../src/runtime/actors/compaction/summarizer.js';
import { ProviderTurnFailure, LlmRequestError } from '../../../../src/contracts/index.js';
import { initProjectTree } from '../../../helpers/canonical-project.js';
import { ACTIVITY_ROW_POLICY, TEXT_ROW_POLICY } from '../../../helpers/row-policy-fixtures.js';
import { RESPONSES_A, responsesBundle } from '../../../helpers/responses-producer-fixture.js';
import { deterministicSummarySerialization } from '../../../helpers/summary-serialization.js';
import { noCompactionProgress } from '../../../helpers/executing-llm-snapshot.js';

const SESSION = 'agent:planner:project' as const;
const CANDIDATE = { provider: 'test', account: null, model: 'test' } as const;
const INPUT = '00000000-0000-4000-8000-000000000001';
const timestamp = '2026-10-05T00:00:00.000Z';
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture(rows: AgentMessage[]): string {
  const root = mkdtempSync(join(tmpdir(), 'compaction-tail-selection-'));
  roots.push(root);
  initProjectTree(root);
  appendConversationBatch({ projectRoot: root }, rows);
  return root;
}

function activation(ordinal: number): AgentMessage {
  return {
    ...text(`activation-${ordinal}`, ''), role: 'system', kind: 'activity', context_policy: ACTIVITY_ROW_POLICY,
    content: JSON.stringify({ event: 'activation_open', agent_name: 'planner', card_id: 'project', input_id: `00000000-0000-4000-8000-${String(ordinal).padStart(12, '0')}`, timestamp }),
  };
}

function text(id: string, content: string): AgentMessage {
  return { id, session_id: SESSION, role: 'user', kind: 'text', context_policy: TEXT_ROW_POLICY, content, round_id: `r-user-${'2'.repeat(32)}`, message_index: 1, block_index: 0, timestamp };
}

function body(id: string, bytes: number): AgentMessage { return text(id, `${id}:${'x'.repeat(bytes)}`); }
const tokens = (rows: AgentMessage[]): number => rows.reduce((sum, row) => sum + estimateMessageTokens(row), 0);

type Call = { contents: string[] };
function recordingProvider(outputs: string[] = ['summary']): { provider: SummarizerProviderPort; calls: Call[]; maxInFlight: () => number } {
  const calls: Call[] = [];
  let inFlight = 0;
  let maximum = 0;
  return {
    calls, maxInFlight: () => maximum,
    provider: {
      candidate: CANDIDATE, contextWindowTokens: 100_000, maxOutputTokens: 10_000,
      materializeImage: async () => { throw new Error('Unexpected image materialization.'); },
      serializeSummaryRequest: deterministicSummarySerialization,
      completeTurn: async (input) => {
        maximum = Math.max(maximum, ++inFlight);
        calls.push({ contents: input.providerConversation.messages.map(row => row.content) });
        await Promise.resolve();
        inFlight--;
        return { result: { kind: 'message', content: outputs[Math.min(calls.length - 1, outputs.length - 1)]! }, provider_exchanges: [] };
      },
      projectProviderExchanges: jest.fn(),
    },
  };
}

async function run(root: string, tailBudget: number, snap: AutonomousCompactionPolicy['snap'] = 'compact_straddler', strategy: CompactionStrategy = 'preventive', recorded = recordingProvider(), triggerFraction = 0.8, summaryRefusal: { summaryInputId: string } | null = null) {
  const conversation = readConversation(root, SESSION);
  const preparedCompaction = prepareCompaction({ context_utilization_fraction: 0.8, trigger_fraction: triggerFraction, tail_fraction: tailBudget === 0 ? 0 : (tailBudget + 0.25) / 20_000, snap }, 'system', [], 20_000, 2_000);
  expect(preparedCompaction.tailBudgetTokens).toBe(tailBudget);
  const input: PreparedLlmInvocationInput = {
    inputId: INPUT, agentId: SESSION, agentName: 'planner', sessionId: SESSION, systemPrompt: 'system',
    providerConversation: providerConversationProjection(conversation, []), tools: [], compiledToolContracts: [], terminalToolNames: [], modelParams: { temperature: 0 }, preparedCompaction,
    preparedContext: buildPreparedInvocationContext({ instructionText: 'system', terminalToolNames: [], compiledTools: [], dynamicBlocks: [], preparedCompaction }),
    capabilityRequest: {}, routePass: { kind: 'ordinary', candidateChain: [CANDIDATE] }, episodeContext: {},
  };
  const result = await compact({ summaryRefusal, strategy, conversations: { projectRoot: root }, input, summarizerProvider: recorded.provider, signal: new AbortController().signal, progress: noCompactionProgress });
  return { result, conversation, ...recorded };
}

function assertPublished(root: string, source: ValidatedConversation, cutoffId: string, tail: AgentMessage[]) {
  const segment = readCurrentConversationSegment(root, SESSION)!;
  if (segment.genesis.kind !== 'compacted_segment_genesis') throw new Error('Expected compacted genesis.');
  const history = segment.genesis.compaction;
  expect(segment.genesis.source.covered_through_message_id).toBe(cutoffId);
  expect(segment.rows.map(row => row.id)).toEqual(tail.map(row => row.id));
  expect(Buffer.from(canonicalJson(segment.rows))).toEqual(Buffer.from(canonicalJson(tail)));
  expect(readConversation(root, SESSION)).toEqual(segment.conversation);
  const cutoff = source.sourceRows.findIndex(row => row.id === cutoffId) + 1;
  validateCompactedHistorySuccessor({
    source, sourceVersion: segment.genesis.source.version,
    successor: history, coveredRows: source.sourceRows.slice(0, cutoff),
  });
  return segment;
}

function assertTextSources(calls: Call[], expected: AgentMessage[]) {
  const sources = calls.flatMap(call => call.contents.flatMap(content => {
    const match = content.match(/kind=new_source source=([^ ]+) source_kind=message:direct /);
    return match ? [{ id: match[1], content: content.slice(content.indexOf('\n') + 1) }] : [];
  }));
  expect(sources).toEqual(expected.map(row => ({ id: row.id, content: row.content })));
}

describe('last agent-round tail selection through real publication', () => {
  const refused = (): ReturnType<typeof recordingProvider> => {
    const recorded = recordingProvider();
    recorded.provider.completeTurn = jest.fn(async (input) => {
      throw new ProviderTurnFailure({ failure_phase: 'provider_attempt', candidate: CANDIDATE, provider_exchanges: [], originalFailure: new LlmRequestError({ kind: 'content_policy', provider: 'test', status: 200, message: 'cyber_policy', providerResponse: '' }) });
    });
    return recorded;
  };

  it.each(['preventive', 'local_exact_admission', 'authoritative_context_recovery'] as const)('first refusal selects preferred local omission for %s even though furthest is smaller', async strategy => {
    const recent = body('recent', 4_000);
    const rows = [activation(1), body('prefix', 12_000), recent];
    const root = fixture(rows);
    const recorded = refused();
    const completed = await run(root, tokens([recent]), 'compact_straddler', strategy, recorded);
    const segment = assertPublished(root, completed.conversation, 'prefix', [recent]);
    expect(segment.conversation.effectiveCompactedHistory!.summaryText).toBe(LOCAL_OMISSION_SUMMARY);
    expect(completed.result).toMatchObject({ kind: 'compacted', summaryRefusal: { summaryInputId: expect.any(String) } });
    expect(recorded.provider.completeTurn).toHaveBeenCalledTimes(1);
    expect(recorded.provider.projectProviderExchanges).toHaveBeenCalledTimes(1);
    expect(segment.conversation.effectiveCompactedHistory!.requiredModelFacts.latestContentPolicyRefusal).toBeNull();
  });

  it('falls through to furthest only when preferred local omission cannot fit preventive hard capacity', async () => {
    const recent = body('recent', 79_500);
    const root = fixture([activation(1), body('prefix', 12_000), recent]);
    const completed = await run(root, tokens([recent]) - 1, 'compact_straddler', 'preventive', refused(), 1);
    assertPublished(root, completed.conversation, 'recent', []);
  });

  it.each([0, 100_000])('does not add summary work for duplicate/absent preferred endpoints (tail=%s)', async tailBudget => {
    // A zero target selects the same furthest cutoff; a whole retained newest
    // round gives no preferred cutoff. Both still have one safe local option.
    const rows = [activation(1), body('prefix', 12_000)];
    const root = fixture(rows);
    const actualBudget = tailBudget ? tokens(rows) + 1 : 0;
    const recorded = refused();
    const completed = await run(root, actualBudget, 'keep_straddler_verbatim', 'local_exact_admission', recorded);
    assertPublished(root, completed.conversation, 'prefix', []);
    expect(recorded.provider.completeTurn).toHaveBeenCalledTimes(1);
  });

  it('same-invocation refusal skips all summary serialization and construction while a later fresh turn may summarize', async () => {
    const root = fixture([activation(1), body('prefix', 12_000), body('recent', 4_000)]);
    const first = await run(root, tokens([body('recent', 4_000)]), 'compact_straddler', 'preventive', refused());
    if (first.result.kind !== 'compacted') throw new Error('Expected successor');
    const recorded = recordingProvider();
    recorded.provider.serializeSummaryRequest = jest.fn(() => { throw new Error('No post-refusal summary request'); });
    const second = await run(root, 0, 'compact_straddler', 'local_exact_admission', recorded, 0.8, first.result.summaryRefusal);
    expect(second.result).toMatchObject({ kind: 'compacted', summaryRefusal: first.result.summaryRefusal });
    expect(recorded.calls).toEqual([]);
    expect(recorded.provider.serializeSummaryRequest).not.toHaveBeenCalled();
    appendConversationBatch({ projectRoot: root }, [body('new-turn', 8_000)]);
    const fresh = await run(root, 0);
    expect(fresh.calls).toHaveLength(1);
    expect(fresh.result).toMatchObject({ kind: 'compacted', summaryRefusal: null });
  });

  it('unshrinkable protected state retains refusal identity and publishes no successor', async () => {
    const protectedRow = { ...body('protected', 12_000), context_policy: { ...TEXT_ROW_POLICY, compactable: false } } as AgentMessage;
    const root = fixture([activation(1), protectedRow]);
    await expect(run(root, 0, 'compact_straddler', 'preventive', recordingProvider(), 0.8, { summaryInputId: INPUT })).rejects.toMatchObject({ name: 'SummaryPolicyRefusalError', summaryInputId: INPUT });
    expect(readConversationCatalog(root, SESSION).versions).toHaveLength(1);
  });

  it('no positive safe endpoint propagates remembered refusal without constructing a candidate', async () => {
    const root = fixture([activation(1), body('prefix', 12_000)]);
    await run(root, 0);
    const recorded = recordingProvider();
    recorded.provider.serializeSummaryRequest = jest.fn(() => { throw new Error('No request'); });
    await expect(run(root, 0, 'compact_straddler', 'authoritative_context_recovery', recorded, 0.8, { summaryInputId: INPUT })).rejects.toMatchObject({ name: 'SummaryPolicyRefusalError', summaryInputId: INPUT });
    expect(recorded.provider.serializeSummaryRequest).not.toHaveBeenCalled();
    expect(readConversationCatalog(root, SESSION).versions).toHaveLength(2);
  });

  it.each(['refusal', 'capacity', 'invalid', 'nonreducing'] as const)('no qualifying omission keeps the %s failure identity and never continues uncompressed', async outcome => {
    const root = fixture([activation(1), text('tiny', 'tiny')]);
    const recorded = recordingProvider([outcome === 'invalid' ? ' ' : 'HUGE'.repeat(4_000)]);
    let providerFailure: ProviderTurnFailure | null = null;
    if (outcome === 'refusal' || outcome === 'capacity') {
      providerFailure = new ProviderTurnFailure({ failure_phase: 'provider_attempt', candidate: CANDIDATE, provider_exchanges: [], originalFailure: outcome === 'refusal' ? new LlmRequestError({ kind: 'content_policy', provider: 'test', status: 200, message: 'cyber_policy', providerResponse: '' }) : new LlmRequestError({ kind: 'input_context_exhausted', provider: 'test', status: 400, message: 'capacity' }) });
      recorded.provider.completeTurn = async () => { throw providerFailure; };
    }
    const result = run(root, 0, 'compact_straddler', 'local_exact_admission', recorded);
    if (outcome === 'refusal') await expect(result).rejects.toBeInstanceOf(SummaryPolicyRefusalError);
    else if (outcome === 'capacity') await expect(result).rejects.toBe(providerFailure);
    else if (outcome === 'invalid') await expect(result).rejects.toMatchObject({ name: 'CompactionSummaryConstructionError', reason: 'empty_output', correctionCount: 1 });
    else await expect(result).resolves.toMatchObject({ result: { kind: 'no_smaller_projection' } });
    expect(readConversationCatalog(root, SESSION).versions).toHaveLength(1);
  });

  it.each(['compact_straddler', 'keep_straddler_verbatim'] as const)('accounts for an exactly fitting open newest round with %s', async snap => {
    const rows = [activation(1), body('old', 12_000), activation(2), body('middle', 4_000), activation(3), body('newest', 1_000)];
    const root = fixture(rows);
    const completed = await run(root, tokens(rows.slice(4)), snap);
    const cutoff = snap === 'compact_straddler' ? 'middle' : 'old';
    assertPublished(root, completed.conversation, cutoff, rows.slice(snap === 'compact_straddler' ? 4 : 2));
    assertTextSources(completed.calls, rows.slice(0, snap === 'compact_straddler' ? 4 : 2).filter(row => row.kind === 'text'));
    expect(completed.calls).toHaveLength(1);
    expect(completed.calls[0]!.contents.join('')).not.toContain('newest:');
  });

  it.each(['compact_straddler', 'keep_straddler_verbatim'] as const)('keeps fitting older rounds whole and snaps only the older straddler with %s', async snap => {
    // Every row shares a provider round_id and card_id; activation markers alone define source rounds.
    const rows = [activation(1), body('old', 12_000), activation(2), body('straddler', 4_000), activation(3), body('fitting-older', 1_000), activation(4), body('newest', 1_000)];
    const root = fixture(rows);
    const completed = await run(root, tokens(rows.slice(4)) + 10, snap);
    const cutoff = snap === 'compact_straddler' ? 'straddler' : 'old';
    assertPublished(root, completed.conversation, cutoff, rows.slice(snap === 'compact_straddler' ? 4 : 2));
    assertTextSources(completed.calls, rows.slice(0, snap === 'compact_straddler' ? 4 : 2).filter(row => row.kind === 'text'));
    expect(completed.calls).toHaveLength(1);
    expect(completed.calls[0]!.contents.join('')).not.toContain('fitting-older:');
    expect(completed.conversation.rounds).toHaveLength(4);
  });

  it.each([
    ['compact_straddler', false, false], ['keep_straddler_verbatim', false, false],
    ['compact_straddler', true, false], ['keep_straddler_verbatim', true, false],
    ['compact_straddler', true, true],
  ] satisfies Array<[AutonomousCompactionPolicy['snap'], boolean, boolean]>)('retains the oversized newest suffix with %s (sole=%s, crossing=%s)', async (snap, sole, crossing) => {
    const earlier = sole ? [] : [activation(1), body('earlier', 8_000)];
    const newest = [activation(2), body('old-prefix', 8_000), body('crossing', 4_000), body('recent', 1_000)];
    const rows = [...earlier, ...newest];
    const root = fixture(rows);
    const completed = await run(root, tokens(newest.slice(3)) + (crossing ? 1 : 0), snap);
    assertPublished(root, completed.conversation, crossing ? 'old-prefix' : 'crossing', newest.slice(crossing ? 2 : 3));
    assertTextSources(completed.calls, [...earlier, ...newest.slice(0, crossing ? 2 : 3)].filter(row => row.kind === 'text'));
    expect(completed.calls).toHaveLength(1);
    const source = completed.calls[0]!.contents.join('');
    expect(source).toContain('old-prefix:');
    expect(source.includes('earlier:')).toBe(!sole);
    expect(source.includes('crossing:')).toBe(!crossing);
    expect(source).not.toContain('recent:');
  });

  it.each([[false, false], [true, false], [true, true]] satisfies Array<[boolean, boolean]>)('snaps backward across a crossing atomic group (private=%s, private boundary=%s), retaining extra exact bytes', async (withPrivate, privateBoundary) => {
    const result = JSON.stringify({ success: true, data: { content: 'atomic-result:'.concat('z'.repeat(8_000)) } });
    const bundle = responsesBundle(SESSION, INPUT, RESPONSES_A, result);
    const group = withPrivate ? bundle : bundle.slice(1).map(({ provider_projection: _projection, ...row }) => row as AgentMessage);
    const recent = body('recent', 1_000);
    const rows = [activation(1), body('old-prefix', 12_000), ...group, recent];
    const root = fixture(rows);
    const budget = tokens([recent]) + (privateBoundary ? tokens(group.slice(-1)) : 0) + 1;
    const completed = await run(root, budget);
    assertPublished(root, completed.conversation, 'old-prefix', [...group, recent]);
    assertTextSources(completed.calls, [rows[1]!]);
    expect(tokens([...group, recent])).toBeGreaterThan(budget);
    expect(completed.calls).toHaveLength(1);
    expect(completed.calls[0]!.contents.join('')).not.toContain('atomic-result:');
    expect(completed.calls[0]!.contents.join('')).not.toContain('producer_account_id');
  });

  it.each([false, true])('zero budget covers all settled rows once but not a final unmatched call (unmatched=%s)', async unmatched => {
    const call = responsesBundle(SESSION, INPUT, RESPONSES_A, '{"success":true,"data":"ok"}')[1]!;
    const { provider_projection: _projection, ...plainCall } = call;
    const tail = unmatched ? [plainCall as AgentMessage] : [];
    const rows = [activation(1), body('settled', 12_000), ...tail];
    const root = fixture(rows);
    const completed = await run(root, 0);
    const segment = assertPublished(root, completed.conversation, 'settled', tail);
    assertTextSources(completed.calls, [rows[1]!]);
    expect(completed.calls).toHaveLength(1);
    if (segment.genesis.kind !== 'compacted_segment_genesis') throw new Error('Expected genesis.');
    expect(segment.genesis.continuation).toEqual({ kind: 'inherited_open_round', activation: { marker_id: 'activation-1', input_id: INPUT }, active_segment_kind: 'initial' });
  });

  it.each([
    ['preventive', 'recent', 2], ['authoritative_context_recovery', 'prefix', 1], ['local_exact_admission', 'recent', 2],
  ] satisfies Array<[CompactionStrategy, string, number]>)('preserves %s acceptance and incremental sequential fallback', async (strategy, cutoff, callCount) => {
    const recent = body('recent', 4_000);
    const rows = [activation(1), body('prefix', 12_000), recent];
    const root = fixture(rows);
    const recorded = recordingProvider(['FIRST-SUMMARY:'.concat('S'.repeat(4_000)), 'FINAL-SUMMARY']);
    const completed = await run(root, tokens([recent]), 'compact_straddler', strategy, recorded, 0.08);
    assertPublished(root, completed.conversation, cutoff, cutoff === 'prefix' ? [recent] : []);
    assertTextSources(completed.calls, cutoff === 'prefix' ? [rows[1]!] : [rows[1]!, recent]);
    expect(completed.calls).toHaveLength(callCount);
    expect(completed.maxInFlight()).toBe(1);
    expect(completed.calls[0]!.contents.join('')).toContain('prefix:');
    expect(completed.calls[0]!.contents.join('')).not.toContain('recent:');
    if (callCount === 2) {
      expect(completed.calls[1]!.contents.join('')).toContain('recent:');
      expect(completed.calls[1]!.contents.join('')).toContain('FIRST-SUMMARY:');
      expect(completed.calls[1]!.contents.join('')).not.toContain('prefix:');
    }
  });

  it('recompacts only inherited genesis plus new rows, preserving repair continuation and one summary', async () => {
    const repair = { ...body('repair', 4_000), kind: 'model_repair' as const };
    const recent = body('first-tail', 1_000);
    const root = fixture([activation(1), body('old', 12_000), repair, recent]);
    const predecessor = readCurrentConversationSegment(root, SESSION)!;
    const first = await run(root, tokens([recent]), 'compact_straddler', 'preventive', recordingProvider(['INHERITED-SUMMARY']));
    const firstSegment = assertPublished(root, first.conversation, 'repair', [recent]);
    const older = body('added-older', 4_000);
    const latest = body('added-latest', 1_000);
    appendConversationBatch({ projectRoot: root }, [older, latest]);
    // Missing exact predecessors prove current reads/refinement never open historical bodies.
    unlinkSync(cardConversationVersionFile(root, 'project', 'planner', predecessor.entry.filename));
    const second = await run(root, tokens([latest]), 'compact_straddler', 'preventive', recordingProvider(['REPLACEMENT-SUMMARY']));
    const segment = assertPublished(root, second.conversation, 'added-older', [latest]);
    assertTextSources(second.calls, [recent, older]);
    if (segment.genesis.kind !== 'compacted_segment_genesis' || firstSegment.genesis.kind !== 'compacted_segment_genesis') throw new Error('Expected genesis.');
    expect(segment.genesis.continuation).toEqual({ kind: 'inherited_open_round', activation: { marker_id: 'activation-1', input_id: INPUT }, active_segment_kind: 'repair' });
    expect(segment.genesis.source).toMatchObject({ version: firstSegment.entry.version, filename: firstSegment.entry.filename });
    expect(second.calls).toHaveLength(1);
    expect(second.calls[0]!.contents.join('')).toContain('INHERITED-SUMMARY');
    expect(second.calls[0]!.contents.join('')).not.toContain('old:');
    expect(second.calls[0]!.contents.join('')).toContain('first-tail:');
    expect(second.calls[0]!.contents.join('')).toContain('added-older:');
    expect(second.calls[0]!.contents.join('')).not.toContain('added-latest:');
    if (second.result.kind !== 'compacted') throw new Error('Expected compaction.');
    expect(second.result.providerConversation.messages.filter(row => row.kind === 'synthetic_context' && row.origin === 'history_summary')).toHaveLength(1);
    expect(readConversationCatalog(root, SESSION).versions.map(entry => entry.version)).toEqual([1, 2, 3]);
  });

  it('adds no artificial endpoint or history slot for an empty inherited open round', async () => {
    const root = fixture([activation(1), body('old', 12_000)]);
    await run(root, 0);
    const before = readCurrentConversationSegment(root, SESSION)!;
    expect(before.conversation.rounds[0]!.rows).toEqual([]);
    const completed = await run(root, 1_000, 'compact_straddler', 'local_exact_admission');
    expect(completed.result).toMatchObject({ kind: 'no_smaller_projection', smallestCandidateEstimatedProviderMessageTokens: null });
    expect(completed.calls).toEqual([]);
    expect(readCurrentConversationSegment(root, SESSION)).toEqual(before);
    expect(readConversationCatalog(root, SESSION).versions).toHaveLength(2);
  });
});
