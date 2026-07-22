import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ConversationLLMActor, type CompactorPort, type LLMProviderPort } from '../../../src/runtime/actors/llm-actor.js';
import { prepareCompaction } from '../../../src/runtime/actors/compaction/compactor.js';
import type { PreparedLlmInvocationInput } from '../../../src/runtime/actors/llm-invocation.js';
import { readConversation } from '../../../src/persistence/conversation-file.js';
import { initProjectTree } from '../../helpers/canonical-project.js';

const roots: string[] = [];
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });

describe('direct conversation LLM ownership', () => {
  it('keeps conversation, provider evidence, exact terminal handoff, and direct delivery ordered', async () => {
    const root = project();
    const trace: string[] = [];
    const input = preparedInput();
    const actor = llm(root, {
      completeTurn: async () => ({ result: { kind: 'message' as const, content: 'done' }, provider_exchanges: [exchange(input.inputId)] }),
      projectProviderExchanges: (_session, source, _attempts, outputs) => { trace.push(`evidence:${source}:${outputs.join(',')}`); },
    }, {
      changes: {
        conversationChanged: () => trace.push('conversationChanged'),
        agentsChanged: () => trace.push('agentsChanged'),
      } as never,
    });

    const terminal = jest.fn((completion: { input: PreparedLlmInvocationInput }) => {
      expect(completion.input).toBe(input);
      trace.push(`handoff:${completion.input.inputId}`);
    });
    const turn = actor.turn(input, undefined, terminal as never);
    turn.then(() => trace.push('delivery'));

    await expect(turn).resolves.toMatchObject({ type: 'result', result: { content: 'done' } });
    actor.dispose(new Error('test cleanup'));
    await expect(actor.join()).resolves.toEqual({ status: 'joined' });
    expect(terminal).toHaveBeenCalledTimes(1);
    expect(trace).toEqual([
      'conversationChanged', 'agentsChanged', // llm_turn_started
      'conversationChanged', 'agentsChanged',
      `evidence:${input.inputId}:${input.inputId}:message`,
      `handoff:${input.inputId}`,
      'delivery',
    ]);
  });

  it('propagates provider-exchange failure exactly and performs no terminal handoff or result delivery', async () => {
    const root = project();
    const input = preparedInput();
    const evidenceFailure = new Error('provider evidence append failed');
    const terminal = jest.fn();
    const actor = llm(root, {
      completeTurn: async () => ({ result: { kind: 'message' as const, content: 'committed' }, provider_exchanges: [exchange(input.inputId)] }),
      projectProviderExchanges: () => { throw evidenceFailure; },
    });

    const turn = actor.turn(input, undefined, terminal);
    await expect(turn).rejects.toBe(evidenceFailure);
    expect(terminal).not.toHaveBeenCalled();
    expect(readConversation(root, input.sessionId).physicalRows).toContainEqual(expect.objectContaining({ id: `${input.inputId}:message`, content: 'committed' }));
  });

  it('returns and observes the same direct promise when an arming callback fails synchronously', async () => {
    const root = project();
    const failure = new Error('projection failed while arming');
    const provider = jest.fn<LLMProviderPort['completeTurn']>();
    const actor = llm(root, { completeTurn: provider }, {}, () => { throw failure; });

    let turn!: Promise<unknown>;
    expect(() => { turn = actor.turn(preparedInput(), undefined, jest.fn()); }).not.toThrow();
    await expect(turn).rejects.toBe(failure);
    expect(provider).not.toHaveBeenCalled();
    actor.dispose(new Error('test cleanup'));
    await expect(actor.join()).resolves.toEqual({ status: 'joined' });
  });

  it('uses the fresh continuation source when cancellation wins from the continuation hook', async () => {
    const root = project();
    const input = preparedInput();
    let actor!: ConversationLLMActor;
    let continuationId = '';
    let claimedInputId = '';
    const markPublished = jest.fn();
    actor = llm(root, toolProvider());
    const parked = await actor.turn(input, undefined, jest.fn(), (claimed) => { claimedInputId = claimed.inputId; return Object.freeze({ markPublished }); });
    if (parked.type !== 'tool_call') throw new Error('Expected a tool call.');

    const settlement = actor.appendToolResult('call', { success: true }, undefined, (freshId) => {
      continuationId = freshId;
      expect(actor.requestCancellation('hook cancellation')).toMatchObject({ kind: 'claimed', input: { inputId: freshId } });
      return { messages: [{ role: 'user', content: 'must not be appended' }], afterAppend: jest.fn() };
    });
    await expect(settlement).rejects.toThrow('hook cancellation');
    expect(continuationId).not.toBe(input.inputId);
    expect(claimedInputId).toBe(continuationId);
    expect(markPublished).toHaveBeenCalledTimes(1);
    const rows = readConversation(root, input.sessionId).physicalRows;
    expect(rows).toContainEqual(expect.objectContaining({ id: `${input.inputId}:tool-result:call` }));
    expect(rows).toContainEqual(expect.objectContaining({ id: `${continuationId}:message`, content: 'Cancelled: hook cancellation' }));
    expect(rows.some((row) => row.content === 'must not be appended')).toBe(false);
    expect(rows.some((row) => row.id === `${continuationId}:tool-result:call`)).toBe(false);
  });

  it('keeps an admitted publication-unknown child lease in the direct join until supervisor containment', async () => {
    const root = project();
    const actor = llm(root, toolProvider());
    const parked = await actor.turn(preparedInput(), undefined, jest.fn());
    if (parked.type !== 'tool_call') throw new Error('Expected a tool call.');
    const lease = actor.toolInvocationContext(parked).childInvocation.reserveChild('card-a');
    lease.markAdmitted();
    lease.markPublicationUnknown();
    actor.dispose(new Error('owner disposed'));
    let joined = false;
    const joinTask = actor.join().then((value) => { joined = true; return value; });
    await Promise.resolve();
    expect(joined).toBe(false);
    lease.markContained();
    lease.deliverInterruption(new Error('supervisor contained child'));
    await expect(lease.activation).rejects.toThrow('supervisor contained child');
    await expect(joinTask).resolves.toEqual({ status: 'joined' });
  });
});

function project(): string { const root = mkdtempSync(join(tmpdir(), 'saivage-llm-direct-')); roots.push(root); initProjectTree(root); return root; }

function llm(root: string, provider: LLMProviderPort, conversations: Record<string, unknown> = {}, runtimeProjectionChanged?: () => void): ConversationLLMActor {
  return new ConversationLLMActor({
    agentId: 'planner:project',
    provider,
    conversations: { projectRoot: root, ...conversations },
    compactor: { shouldCompact: () => false, compact: jest.fn<CompactorPort['compact']>() },
    summarizerProvider: { completeTurn: jest.fn<LLMProviderPort['completeTurn']>(), projectProviderExchanges: jest.fn() },
    runtimeProjectionChanged,
  });
}

function toolProvider(): LLMProviderPort {
  return { completeTurn: jest.fn(async () => ({ result: { kind: 'tool_calls' as const, tool_calls: [{ id: 'call', type: 'function' as const, function: { name: 'read', arguments: '{}' } }] }, provider_exchanges: [] })) };
}

function preparedInput(): PreparedLlmInvocationInput {
  const inputId = '00000000-0000-4000-8000-000000000041';
  const systemPrompt = 'system';
  return {
    inputId, agentId: 'planner:project', role: 'planner', sessionId: 'planner:project', systemPrompt,
    providerConversation: { sourceSessionId: 'planner:project', messages: [] }, tools: [], terminalToolNames: [], modelParams: {},
    preparedCompaction: prepareCompaction({ input_budget_tokens: 10_000, trigger_fraction: 0.8, completion_reserve_fraction: 0.2, merge_line_fraction: 0.3, summary_line_fraction: 0.5, escalate_merge_line_fraction: 0.4, escalate_summary_line_fraction: 0.6, snap: 'compact_straddler' }, systemPrompt, []),
    capabilityRequest: {}, episodeContext: {},
  };
}

function exchange(inputId: string) {
  return { contract_id: 'planner.v1', contract_name: 'planner', transport: 'generic' as const, provider: 'test', model: 'model', source_input_id: inputId, attempt_index: 0, request_params: {}, started_at: '2026-07-21T00:00:00.000Z', completed_at: '2026-07-21T00:00:00.001Z', status: 'ok' as const, response_status: 200, terminal_tool_fired: null };
}
