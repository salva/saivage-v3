import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { currentConversationSegmentPath } from '../helpers/current-conversation-segment-path.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InvocationService, type InvocationRequest } from '../../src/agents/invocation-service.js';
import { ProviderRegistry } from '../../src/agents/provider.js';
import { MemoryCandidateAvailability } from '../../src/agents/candidate-availability.js';
import { responsesProducerAccountId } from '../../src/agents/llm-openai-responses-account.js';
import { DEFAULT_SAIVAGE_CONFIG } from '../../src/config/system-templates/registry.js';
import { NO_FRESHNESS_EFFECTS, type Candidate } from '../../src/contracts/index.js';
import { sha256Hex, STRUCTURAL_ROW_POLICY, type AgentMessage } from '../../src/schemas/index.js';
import { appendConversationBatch, readConversation, readCurrentConversationSegment } from '../../src/persistence/conversation-file.js';
import { providerConversationProjection } from '../../src/runtime/actors/conversation-session.js';
import { appendLlmTurnMessageBatch } from '../../src/runtime/actors/llm-delivery-log.js';
import { initProjectTree } from '../helpers/canonical-project.js';
import { readProviderExchangeEntries } from '../../src/persistence/provider-exchange-log.js';
import { readAppLogEntries } from '../../src/persistence/app-log.js';
import { RESPONSES_A, RESPONSES_B, responsesBundle } from '../helpers/responses-producer-fixture.js';

const SESSION = 'agent:planner:project' as const;
const SOURCE = '11111111-1111-4111-8111-111111111111';
const INPUT = '22222222-2222-4222-8222-222222222222';
const roots: string[] = [];
afterEach(() => { jest.useRealTimers(); jest.restoreAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture(chain: Candidate[]) {
  const root = mkdtempSync(join(tmpdir(), 'responses-producer-')); roots.push(root); initProjectTree(root);
  const marker: AgentMessage = { id: 'activation', session_id: SESSION, kind: 'activity', role: 'system', context_policy: STRUCTURAL_ROW_POLICY.activation_boundary, content: JSON.stringify({ event: 'activation_open', agent_name: 'planner', card_id: 'project', input_id: SOURCE, timestamp: '2026-10-03T00:00:00.000Z' }), round_id: `r-pre-${'0'.repeat(32)}`, message_index: 0, block_index: 0, timestamp: '2026-10-03T00:00:00.000Z' };
  appendConversationBatch({ projectRoot: root }, [marker, ...responsesBundle(SESSION, SOURCE, RESPONSES_A, '{"success":true,"data":"tool-result"}')]);
  const registry = new ProviderRegistry({ ...structuredClone(DEFAULT_SAIVAGE_CONFIG), providers: { responses: { models: ['m'], baseUrl: 'https://responses.example.test', capabilities: { transportProtocol: 'openai-responses', toolsMode: 'native', exclusiveToolChoiceSupport: 'native', contextWindowTokens: 100_000, maxOutputTokens: 10_000 }, accounts: { a: { apiKey: 'test-a' }, b: { apiKey: 'test-b' } } } } });
  const service = new InvocationService({ projectRoot: root, registry, candidateAvailability: new MemoryCandidateAvailability(), freshness: NO_FRESHNESS_EFFECTS });
  const request: InvocationRequest = { inputId: INPUT, agentName: 'planner', sessionId: SESSION, systemPrompt: 'system', providerConversation: providerConversationProjection(readConversation(root, SESSION), []), tools: [], terminalToolNames: [], modelParams: { temperature: 0, maxTokens: 2000 }, capabilityRequest: {}, routePass: { kind: 'ordinary', candidateChain: chain } };
  const admission = service.preparePrimaryRequestAdmission(request);
  if (admission.kind !== 'admitted') throw new Error('fixture admission failed');
  return { root, service, request, admission };
}

function success() {
  return new Response(JSON.stringify({ status: 'completed', producer_account_id: 'untrusted-remote-identity', output: [{ type: 'reasoning', encrypted_content: 'new-ciphertext' }, { type: 'message', content: [{ type: 'output_text', text: 'B visible completion' }] }] }), { status: 200 });
}

describe('Responses producer through real ordinary invocation', () => {
  it('admits candidate-local bytes before ordinary A503 -> B failover and persists actual B provenance', async () => {
    const { root, service, request, admission } = fixture([RESPONSES_A, RESPONSES_B]);
    const before = JSON.stringify(request.providerConversation);
    const durableBefore = readFileSync(currentConversationSegmentPath(root, SESSION));
    const appLogBefore = readAppLogEntries(root);
    const fetch = jest.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('{}', { status: 503 })).mockResolvedValueOnce(success());
    const completion = await service.executeAdmittedWithRecovery(admission);
    expect(fetch).toHaveBeenCalledTimes(2);
    const ownerKey = sha256Hex(JSON.stringify(['saivage-provider-session', root, SESSION]));
    expect(admission.execution.options.providerSessionId).toBe(ownerKey);
    for (const [index, verdict] of admission.candidates.entries()) {
      if (verdict.kind !== 'admitted') throw new Error('candidate not admitted');
      const init = fetch.mock.calls[index]![1]!;
      const body = init.body as string;
      expect(body).not.toContain(ownerKey);
      expect(JSON.parse(body)).not.toHaveProperty('prompt_cache_key');
      expect(new Headers(init.headers).has('session-id')).toBe(false);
      expect(body).toBe(verdict.plan.request.serializedBody);
      expect(sha256Hex(body)).toBe(verdict.plan.request.requestHash);
      expect(Math.ceil(Buffer.byteLength(body) / 4)).toBe(verdict.plan.request.estimatedWireInputTokens);
      expect(body.includes(`ciphertext-${SOURCE}`)).toBe(index === 0);
      expect(body).toContain(`visible-${SOURCE}`);
      expect(body).toContain('function_call_output');
      expect(body).toContain('tool-result');
      expect(body).not.toContain('producer_account_id');
      for (const candidate of [RESPONSES_A, RESPONSES_B]) {
        expect(body).not.toContain(responsesProducerAccountId(candidate));
        expect(JSON.stringify([...new Headers(init.headers)])).not.toContain(responsesProducerAccountId(candidate));
      }
    }
    expect(completion.provider_private_context?.producer_account_id).toBe(responsesProducerAccountId(RESPONSES_B));
    expect(completion.provider_exchanges).toMatchObject([{ account: 'a', response_status: 503 }, { account: 'b', status: 'ok' }]);
    expect(JSON.stringify(completion.provider_exchanges)).not.toContain('producer_account_id');
    expect(JSON.stringify(completion.provider_exchanges)).not.toContain(ownerKey);
    expect(JSON.stringify(completion.provider_exchanges)).not.toContain(root);
    expect(JSON.stringify(completion.provider_exchanges)).not.toContain(responsesProducerAccountId(RESPONSES_B));
    expect(JSON.stringify(request.providerConversation)).toBe(before);
    expect(readFileSync(currentConversationSegmentPath(root, SESSION))).toEqual(durableBefore);
    const sentInputs = fetch.mock.calls.map(call => JSON.parse(call[1]!.body as string).input);
    expect(sentInputs[1]).toEqual(sentInputs[0].filter((item: { type: string; encrypted_content?: string }) => !(item.type === 'reasoning' && Object.hasOwn(item, 'encrypted_content'))));
    appendLlmTurnMessageBatch({ projectRoot: root }, { ...request, sessionId: SESSION, agentId: SESSION, compiledToolContracts: [], episodeContext: {} }, 'B visible completion', completion.provider_private_context);
    const rows = readCurrentConversationSegment(root, SESSION)!.rows;
    expect(JSON.parse(rows.filter(row => row.kind === 'provider_private').at(-1)!.content).producer_account_id).toBe(responsesProducerAccountId(RESPONSES_B));
    service.projectProviderExchanges(SESSION, 'primary', INPUT, completion.provider_exchanges, { assistantOutputIds: [`${INPUT}:message`], terminalConversationOutputId: null });
    const evidence = readProviderExchangeEntries(root, SESSION);
    expect(evidence).toHaveLength(2);
    expect(evidence[1]!.data).toMatchObject({ payload: { status: 'ok', account: 'b' } });
    for (const data of [evidence, readAppLogEntries(root)]) {
      expect(JSON.stringify(data)).not.toContain(ownerKey);
      expect(JSON.stringify(data)).not.toContain(root);
      expect(JSON.stringify(data)).not.toContain('producer_account_id');
      expect(JSON.stringify(data)).not.toContain(responsesProducerAccountId(RESPONSES_B));
      expect(JSON.stringify(data)).not.toContain('new-ciphertext');
    }
    expect(readAppLogEntries(root)).toEqual(appLogBefore);
  });

  it('keeps equal-account invalid_encrypted_content terminal with one request and unchanged durable history', async () => {
    const { root, service, admission } = fixture([RESPONSES_A, RESPONSES_B]);
    const before = readFileSync(currentConversationSegmentPath(root, SESSION));
    const fetch = jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ error: { code: 'invalid_encrypted_content', message: 'invalid encrypted content' } }), { status: 400 }));
    await expect(service.executeAdmittedWithRecovery(admission)).rejects.toMatchObject({ originalFailure: { failure: { kind: 'provider_protocol_error', status: 400 } } });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0]![1]!.body).toContain(`ciphertext-${SOURCE}`);
    expect(readFileSync(currentConversationSegmentPath(root, SESSION))).toEqual(before);
  });

  it('reuses byte-identical mismatched-account admitted body for a same-candidate transient retry', async () => {
    jest.useFakeTimers();
    const { service, admission } = fixture([RESPONSES_B]);
    const fetch = jest.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('{}', { status: 503 })).mockResolvedValueOnce(success());
    const pending = service.executeAdmittedWithRecovery(admission);
    await jest.advanceTimersByTimeAsync(60_000);
    await pending;
    expect(fetch).toHaveBeenCalledTimes(2);
    const bodies = fetch.mock.calls.map(call => call[1]!.body);
    expect(bodies[1]).toBe(bodies[0]);
    expect(bodies[0]).not.toContain(`ciphertext-${SOURCE}`);
    const verdict = admission.candidates[0]!;
    if (verdict.kind !== 'admitted') throw new Error('candidate not admitted');
    expect(bodies[0]).toBe(verdict.plan.request.serializedBody);
  });
});
