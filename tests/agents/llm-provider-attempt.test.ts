import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { CandidateRequestPlanIntegrityError, type CandidateRequestPlan } from '../../src/agents/candidate-request.js';
import { executeLlmProviderAttempt } from '../../src/agents/llm-provider-attempt.js';
import type { LlmCompleteOptions } from '../../src/agents/llm-contracts.js';
import type { LlmProtocolAdapter } from '../../src/agents/llm-protocol-adapter.js';
import { selectLlmProtocolAdapter } from '../../src/agents/llm-protocol-adapter.js';
import { LlmRequestError } from '../../src/agents/llm-errors.js';

const candidate = { provider: 'test', account: null, model: 'model' } as const;
const options = (signal?: AbortSignal): LlmCompleteOptions => ({ inputId: 'input', contract_id: 'planner.v1', contractName: 'planner', terminalToolOffered: ['done'], tools: [], tool_choice: 'auto', signal });
const capabilities = { transportProtocol: 'openai-chat-completions' as const, toolsMode: 'native' as const, exclusiveToolChoiceSupport: 'native' as const, streaming: false, quirks: [] };

function fixture(overrides: Partial<LlmProtocolAdapter> = {}): { plan: CandidateRequestPlan; registry: never; trace: string[] } {
  const trace: string[] = [];
  const adapter: LlmProtocolAdapter = {
    credentialRequirement: 'standard',
    buildRequestBody: () => ({ value: 1 }),
    deriveWire: () => { trace.push('wire'); return { endpoint: 'https://provider.test/v1/chat/completions', headers: {}, requestParams: {}, transport: 'generic', streaming: false }; },
    classifyHttpFailure: (_candidate, response) => new LlmRequestError({ kind: 'server_transient', provider: 'test', status: response.status, message: 'http failed' }),
    parseSuccess: async () => ({ result: { kind: 'message', content: 'ok', usage: { total_tokens: 2 } }, finishReason: 'stop' }),
    ...overrides,
  };
  const serializedBody = '{"value":1}';
  const plan: CandidateRequestPlan = { candidate, capabilities, adapter, request: { body: { value: 1 }, serializedBody, estimatedWireInputTokens: 3, requestHash: createHash('sha256').update(serializedBody).digest('hex') } };
  const account = { name: '_implicit', models: ['model'] };
  const provider = { name: 'test', models: ['model'], baseUrl: 'https://provider.test', apiKey: 'key', implicitAccount: account, getAllAccounts: () => [] };
  const registry = { get: () => { trace.push('credentials'); return provider; }, getEffectiveCapabilities: () => { throw new Error('must not rediscover capabilities'); } } as never;
  return { plan, registry, trace };
}

afterEach(() => { jest.restoreAllMocks(); });

describe('shared LLM provider attempt', () => {
  it('fails fast for an impossible transport protocol', () => {
    expect(() => selectLlmProtocolAdapter('unexpected' as never)).toThrow("Unsupported LLM transport protocol 'unexpected'.");
  });

  it('fails an already cancelled attempt before credentials, wire derivation, or fetch', async () => {
    const reason = new Error('already stopped'); const controller = new AbortController(); controller.abort(reason); const value = fixture(); const fetchSpy = jest.spyOn(globalThis, 'fetch');
    await expect(executeLlmProviderAttempt({ projectRoot: '.', registry: value.registry, sessionId: 'planner:project', plan: value.plan, options: options(controller.signal) })).rejects.toBe(reason);
    expect(value.trace).toEqual([]); expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('throws the singular integrity error before capability, credentials, wire, recorder, or fetch and ignores the options copy', async () => {
    const value = fixture(); value.plan.request.serializedBody = '{"corrupt":true}'; const supplied = options(); supplied.builtCandidateRequest = { body: {}, serializedBody: '{}', estimatedWireInputTokens: 1, requestHash: createHash('sha256').update('{}').digest('hex') }; const fetchSpy = jest.spyOn(globalThis, 'fetch');
    const pending = executeLlmProviderAttempt({ projectRoot: '.', registry: value.registry, sessionId: 'summary:test', plan: value.plan, options: supplied });
    await expect(pending).rejects.toBeInstanceOf(CandidateRequestPlanIntegrityError); expect(value.trace).toEqual([]); expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('checks capabilities before credentials and attempt start', async () => {
    const value = fixture(); value.plan.capabilities = { ...capabilities, toolsMode: 'unsupported' }; const opts = options(); opts.tools = [{ type: 'function', function: { name: 'x', description: 'x', parameters: {} } }]; const fetchSpy = jest.spyOn(globalThis, 'fetch');
    await expect(executeLlmProviderAttempt({ projectRoot: '.', registry: value.registry, sessionId: 'planner:project', plan: value.plan, options: opts })).rejects.toMatchObject({ failure: { kind: 'capability_mismatch' } });
    expect(value.trace).toEqual([]); expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('resolves credentials before wire derivation and settles one success with terminal evidence', async () => {
    const value = fixture({ parseSuccess: async () => ({ result: { kind: 'tool_calls', tool_calls: [{ id: '1', type: 'function', function: { name: 'done', arguments: '{}' } }], usage: { total_tokens: 2 } }, finishReason: 'tool_calls' }) });
    jest.spyOn(globalThis, 'fetch').mockImplementation(async () => { value.trace.push('fetch'); return new Response('{}', { status: 200 }); });
    const result = await executeLlmProviderAttempt({ projectRoot: '.', registry: value.registry, sessionId: 'planner:project', plan: value.plan, options: options() });
    expect(value.trace).toEqual(['credentials', 'wire', 'fetch']); expect(result.provider_exchanges).toHaveLength(1); expect(result.provider_exchanges[0]).toMatchObject({ status: 'ok', response_status: 200, terminal_tool_fired: 'done' });
  });

  it('evaluates generic capabilities once before credentials, wire derivation, and fetch', async () => {
    const value = fixture();
    let capabilityReads = 0;
    value.plan.capabilities = {
      ...capabilities,
      get exclusiveToolChoiceSupport() {
        capabilityReads += 1;
        return 'native' as const;
      },
    };
    jest.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      value.trace.push('fetch');
      return new Response('{}', { status: 200 });
    });
    await executeLlmProviderAttempt({ projectRoot: '.', registry: value.registry, sessionId: 'planner:project', plan: value.plan, options: options() });
    expect(capabilityReads).toBe(1);
    expect(value.trace).toEqual(['credentials', 'wire', 'fetch']);
  });

  it('records a raw fetch error before generic recovery classification', async () => {
    const value = fixture(); jest.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('socket closed'));
    await expect(executeLlmProviderAttempt({ projectRoot: '.', registry: value.registry, sessionId: 'planner:project', plan: value.plan, options: options() })).rejects.toMatchObject({ provider_exchanges: [{ status: 'error', error: { name: 'TypeError', message: 'socket closed' } }], originalFailure: { failure: { kind: 'unknown' } } });
  });

  it('records a non-Error throw with ordinary evidence before classifying it', async () => {
    const value = fixture();
    jest.spyOn(globalThis, 'fetch').mockRejectedValue('socket closed');
    await expect(executeLlmProviderAttempt({ projectRoot: '.', registry: value.registry, sessionId: 'planner:project', plan: value.plan, options: options() })).rejects.toMatchObject({
      provider_exchanges: [{ status: 'error', error: { name: 'Error', message: 'socket closed' } }],
      originalFailure: { failure: { kind: 'unknown', message: 'socket closed' } },
    });
  });

  it('records an identity-equal custom owner reason raw, then types cancellation without generic classification', async () => {
    const value = fixture(); const controller = new AbortController(); const reason = new Error('owner stopped'); jest.spyOn(globalThis, 'fetch').mockImplementation(async () => { controller.abort(reason); throw reason; });
    await expect(executeLlmProviderAttempt({ projectRoot: '.', registry: value.registry, sessionId: 'planner:project', plan: value.plan, options: options(controller.signal) })).rejects.toMatchObject({ provider_exchanges: [{ status: 'error', error: { name: 'Error', message: 'owner stopped' } }], originalFailure: { failure: { kind: 'cancelled', reason: 'abort' } } });
  });

  it('does not relabel a distinct error merely because the signal is aborted', async () => {
    const value = fixture(); const controller = new AbortController(); const reason = new Error('same'); const distinct = new Error('same'); jest.spyOn(globalThis, 'fetch').mockImplementation(async () => { controller.abort(reason); throw distinct; });
    await expect(executeLlmProviderAttempt({ projectRoot: '.', registry: value.registry, sessionId: 'planner:project', plan: value.plan, options: options(controller.signal) })).rejects.toMatchObject({ originalFailure: { failure: { kind: 'unknown' } } });
  });

  it('records typed HTTP status before exposing the same typed recovery failure', async () => {
    const value = fixture(); jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('bad', { status: 503 }));
    await expect(executeLlmProviderAttempt({ projectRoot: '.', registry: value.registry, sessionId: 'planner:project', plan: value.plan, options: options() })).rejects.toMatchObject({ provider_exchanges: [{ status: 'error', response_status: 503, error: { name: 'LlmRequestError', status: 503 } }], originalFailure: { failure: { kind: 'server_transient', status: 503 } } });
  });

  it('records a parser-produced typed failure exactly once before exposing it unchanged to recovery', async () => {
    const parseFailure = new LlmRequestError({ kind: 'server_transient', provider: 'test', status: 200, message: 'malformed provider payload' });
    const value = fixture({ parseSuccess: async () => { throw parseFailure; } });
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 200 }));
    await expect(executeLlmProviderAttempt({ projectRoot: '.', registry: value.registry, sessionId: 'planner:project', plan: value.plan, options: options() })).rejects.toMatchObject({
      provider_exchanges: [{ status: 'error', response_status: 200, error: { name: 'LlmRequestError', message: 'malformed provider payload', status: 200 } }],
      originalFailure: parseFailure,
    });
  });

  it('records a Codex-style typed SSE failure after HTTP 200 with no ok envelope', async () => {
    const streamFailure = new LlmRequestError({ kind: 'input_context_exhausted', provider: 'openai-codex', status: 200, message: 'context exhausted in stream' });
    const value = fixture({
      deriveWire: () => { value.trace.push('wire'); return { endpoint: 'https://provider.test/codex/responses', headers: {}, requestParams: {}, transport: 'codex', streaming: true }; },
      parseSuccess: async () => { throw streamFailure; },
    });
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('data: failure\n\n', { status: 200, headers: { 'content-type': 'text/event-stream' } }));
    try {
      await executeLlmProviderAttempt({ projectRoot: '.', registry: value.registry, sessionId: 'planner:project', plan: value.plan, options: options() });
      throw new Error('Expected provider attempt to fail.');
    } catch (error) {
      expect(error).toMatchObject({
        provider_exchanges: [{ status: 'error', response_status: 200, error: { name: 'LlmRequestError', message: 'context exhausted in stream', status: 200 } }],
        originalFailure: streamFailure,
      });
      expect((error as { provider_exchanges: Array<{ status: string }> }).provider_exchanges).toHaveLength(1);
      expect((error as { provider_exchanges: Array<{ status: string }> }).provider_exchanges).not.toContainEqual(expect.objectContaining({ status: 'ok' }));
    }
  });

  it('keeps credential/setup failure pre-attempt with no fetch or adapter wire work', async () => {
    const value = fixture();
    value.registry = { get: () => undefined } as never;
    const fetchSpy = jest.spyOn(globalThis, 'fetch');
    await expect(executeLlmProviderAttempt({ projectRoot: '.', registry: value.registry, sessionId: 'planner:project', plan: value.plan, options: options() })).rejects.toMatchObject({ failure: { kind: 'local_setup_error', reason: 'missing_provider' } });
    expect(value.trace).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('settles exactly one error envelope when HTTP classification throws', async () => {
    let classifications = 0;
    const value = fixture({
      classifyHttpFailure: (_candidate, response) => {
        classifications += 1;
        return new LlmRequestError({ kind: 'server_transient', provider: 'test', status: response.status, message: 'once' });
      },
    });
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('bad', { status: 503 }));
    try {
      await executeLlmProviderAttempt({ projectRoot: '.', registry: value.registry, sessionId: 'planner:project', plan: value.plan, options: options() });
      throw new Error('Expected provider attempt to fail.');
    } catch (error) {
      expect(classifications).toBe(1);
      expect((error as { provider_exchanges: unknown[] }).provider_exchanges).toHaveLength(1);
    }
  });
});
