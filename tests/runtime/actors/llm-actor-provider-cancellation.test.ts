import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConversationLLMActor } from '../../../src/runtime/actors/llm-actor.js';
import { InvocationService } from '../../../src/agents/invocation-service.js';
import { MemoryCandidateAvailability } from '../../../src/agents/candidate-availability.js';
import { createInvocationServiceProvider } from '../../../src/application/invocation-service-provider.js';
import { NO_FRESHNESS_EFFECTS, PublicationOutcomeUnknownError } from '../../../src/contracts/index.js';
import { appendConversationBatch, readConversation } from '../../../src/persistence/conversation-file.js';
import { providerExchangeFile } from '../../../src/persistence/layout.js';
import { agentMessageSchema } from '../../../src/schemas/index.js';
import { prepareCompaction } from '../../../src/runtime/actors/compaction/compactor.js';
import { buildPreparedInvocationContext } from '../../../src/runtime/actors/context/context-blocks.js';
import { initProjectTree } from '../../helpers/canonical-project.js';
import { testCompactor, unusedSummarizerProvider } from '../../helpers/llm-test-helpers.js';
import { chatSuccess, invocationProviderRegistry } from '../../helpers/invocation-provider-fixture.js';

const roots: string[] = [];
afterEach(() => { jest.restoreAllMocks(); while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'llm-real-provider-cancel-')); roots.push(root); initProjectTree(root);
  const sessionId = 'agent:analyst:global' as const;
  const inputId = '00000000-0000-4000-8000-000000000001';
  const candidate = { provider: 'test', account: null, model: 'test-model' };
  const conversationChanged = jest.fn();
  const exchangeChanged = jest.fn();
  const conversations = { projectRoot: root, changes: { conversationChanged, agentMembershipChanged: jest.fn() } };
  appendConversationBatch(conversations, [agentMessageSchema.parse({ id: 'activation', session_id: sessionId, role: 'system', kind: 'activity', content: JSON.stringify({ event: 'activation_open', agent_name: 'analyst', input_id: inputId, timestamp: '2026-10-01T00:00:00.000Z' }), context_policy: { kind: 'structural', behavior: 'activation_boundary' }, round_id: 'r-pre-00000000000000000000000000000000', message_index: 0, block_index: 0, timestamp: '2026-10-01T00:00:00.000Z' })]);
  const availability = new MemoryCandidateAvailability();
  const service = new InvocationService({ projectRoot: root, registry: invocationProviderRegistry([candidate]), candidateAvailability: availability, freshness: { ...NO_FRESHNESS_EFFECTS, llmExchangeChanged: exchangeChanged } });
  let fatalEntered!: (error: PublicationOutcomeUnknownError) => void;
  const fatalDelivery = new Promise<PublicationOutcomeUnknownError>((resolve) => { fatalEntered = resolve; });
  const fatal = jest.fn((error: PublicationOutcomeUnknownError): never => { fatalEntered(error); throw error; });
  const actor = new ConversationLLMActor({ purpose: { kind: 'global-agent' }, agentId: sessionId, provider: createInvocationServiceProvider(service), conversations, compactor: testCompactor, summarizerProvider: unusedSummarizerProvider, fatalPort: { publicationOutcomeUnknown: fatal } });
  const preparedCompaction = prepareCompaction({ context_utilization_fraction: .8, trigger_fraction: .8, tail_fraction: .25, snap: 'compact_straddler' }, 'system', [], 8_000, 2_000);
  const input = { inputId, agentId: sessionId, agentName: 'analyst' as const, sessionId, systemPrompt: 'system', providerConversation: { sourceSessionId: sessionId, messages: [] }, tools: [], compiledToolContracts: [], terminalToolNames: [], modelParams: { temperature: 0 }, preparedCompaction, preparedContext: buildPreparedInvocationContext({ instructionText: 'system', terminalToolNames: [], compiledTools: [], dynamicBlocks: [], preparedCompaction }), capabilityRequest: {}, routePass: { kind: 'ordinary' as const, candidateChain: [candidate] }, episodeContext: {} };
  let release!: (response: Response) => void;
  let entered!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const fetch = jest.spyOn(globalThis, 'fetch').mockImplementation(() => new Promise((resolve) => { release = resolve; entered(); }));
  return { root, actor, input, service, availability, fatal, fatalDelivery, conversationChanged, exchangeChanged, fetch, started, release: (response: Response) => release(response) };
}

describe('real InvocationService successful-return cancellation ownership', () => {
  it('persists known graceful success and its one linked exchange through the normal actor completion, without terminal callback', async () => {
    const f = fixture();
    const succeeded = jest.spyOn(f.availability, 'markSucceeded');
    const terminal = jest.fn();
    const pending = f.actor.turn(f.input, undefined, terminal);
    await f.started;
    f.actor.requestGracefulCancellation(new Error('controlled interruption'));
    f.release(chatSuccess('known result'));
    await expect(pending).resolves.toMatchObject({ type: 'result' });
    const rows = readConversation(f.root, f.input.sessionId).sourceRows;
    const output = rows.find((row) => row.role === 'assistant' && row.content === 'known result');
    expect(output).toBeDefined();
    expect(rows.some((row) => row.kind === 'model_issue' || row.content.includes('llm_turn_error'))).toBe(false);
    const evidence = readFileSync(providerExchangeFile(f.root, f.input.sessionId), 'utf8').trim().split('\n').flatMap((line) => JSON.parse(line).rows).filter((row) => row.type === 'provider_exchange');
    expect(evidence).toHaveLength(1);
    expect(evidence[0].data).toMatchObject({ source_input_id: f.input.inputId, attempt_index: 0, payload: { status: 'ok', assistant_output_ids: [output!.id] } });
    expect(f.fetch).toHaveBeenCalledTimes(1);
    expect(succeeded).not.toHaveBeenCalled();
    expect(terminal).not.toHaveBeenCalled();
    await expect(f.actor.continueAfterPlainText([], undefined, terminal)).rejects.toThrow(/no open plain-text result/);
    await expect(f.actor.join()).resolves.toEqual({ status: 'joined' });
  });

  it('fences a late known success after immediate owner revocation from all output, evidence, hints and delivery', async () => {
    const f = fixture();
    const terminal = jest.fn();
    const pending = f.actor.turn(f.input, undefined, terminal);
    await f.started;
    const before = readConversation(f.root, f.input.sessionId).sourceRows;
    const hints = f.conversationChanged.mock.calls.length;
    const reason = new Error('immediate revocation');
    expect(f.actor.dispose(reason)).toBe('revoked_before_owned_completion');
    await expect(pending).rejects.toBe(reason);
    f.release(chatSuccess('late result'));
    await f.actor.join();
    expect(readConversation(f.root, f.input.sessionId).sourceRows).toEqual(before);
    expect(existsSync(providerExchangeFile(f.root, f.input.sessionId))).toBe(false);
    expect(f.conversationChanged).toHaveBeenCalledTimes(hints);
    expect(f.exchangeChanged).not.toHaveBeenCalled();
    expect(terminal).not.toHaveBeenCalled();
  });

  it('hands completion evidence publication uncertainty to fatal ownership without a secondary error append', async () => {
    const f = fixture();
    const failure = new PublicationOutcomeUnknownError();
    const projection = jest.spyOn(f.service, 'projectProviderExchanges').mockImplementation(() => { throw failure; });
    const terminal = jest.fn();
    void f.actor.turn(f.input, undefined, terminal);
    await f.started;
    f.actor.requestGracefulCancellation(new Error('controlled interruption'));
    f.release(chatSuccess('known result'));
    // The fatal owner terminates production; it does not promise caller settlement.
    await expect(f.fatalDelivery).resolves.toBe(failure);
    expect(f.fatal).toHaveBeenCalledWith(failure);
    expect(projection).toHaveBeenCalledTimes(1);
    const rows = readConversation(f.root, f.input.sessionId).sourceRows;
    expect(rows.filter((row) => row.content === 'known result')).toHaveLength(1);
    expect(rows.some((row) => row.kind === 'model_issue' || row.content.includes('llm_turn_error'))).toBe(false);
    expect(terminal).not.toHaveBeenCalled();
  });
});
