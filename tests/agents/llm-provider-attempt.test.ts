import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { CandidateRequestPlanIntegrityError } from '../../src/agents/candidate-request.js';
import { type CandidateRequestPlan } from '../../src/contracts/index.js';
import { AdmissionIntegrityError } from '../../src/contracts/index.js';
import { executeLlmProviderAttempt } from '../../src/agents/llm-provider-attempt.js';
import type { LlmCompleteOptions } from '../../src/contracts/index.js';
import type { LlmProtocolAdapter } from '../../src/contracts/index.js';
import { selectLlmProtocolAdapter } from '../../src/agents/llm-protocol-adapter.js';
import { LlmRequestError } from '../../src/contracts/llm-failure.js';
import { controlledResponse } from '../helpers/provider-inactivity.js';

const candidate = { provider: 'test', account: null, model: 'model' } as const;
const options = (signal?: AbortSignal): LlmCompleteOptions => ({ providerSessionId: 'synthetic-provider-session', inputId: 'input', temperature: 0.2, max_tokens: 321, contract_id: 'planner.v1', contractName: 'planner', terminalToolOffered: ['done'], tools: [], tool_choice: 'auto', signal });
const capabilities = { transportProtocol: 'openai-chat-completions' as const, imageInput: false, toolsMode: 'native' as const, exclusiveToolChoiceSupport: 'native' as const, quirks: [] };
const capabilityRequest = { requiresTools: false, requiresExclusiveToolChoice: true } as const;

function fixture(overrides: Partial<LlmProtocolAdapter> = {}): { plan: CandidateRequestPlan; registry: never; trace: string[] } {
  const trace: string[] = [];
  const adapter: LlmProtocolAdapter = {
    credentialRequirement: 'standard',
    buildRequestBody: () => ({ value: 1 }),
    deriveWire: () => { trace.push('wire'); return { endpoint: 'https://provider.test/v1/chat/completions', headers: {}, requestParams: {}, transport: 'generic' }; },
    classifyHttpFailure: (_candidate, response) => new LlmRequestError({ kind: 'server_transient', provider: 'test', status: response.status, message: 'http failed' }),
    parseSuccess: async () => ({ result: { kind: 'message', content: 'ok', usage: { total_tokens: 2 } }, finishReason: 'stop' }),
    ...overrides,
  };
  const serializedBody = '{"value":1}';
  const plan: CandidateRequestPlan = { candidate, capabilities, adapter, request: { body: { value: 1 }, serializedBody, imageCount: 0, estimatedWireInputTokens: 3, requestHash: createHash('sha256').update(serializedBody).digest('hex') } };
  const account = { name: '_implicit', models: ['model'] };
  const provider = { name: 'test', models: ['model'], baseUrl: 'https://provider.test', apiKey: 'key', implicitAccount: account, getAllAccounts: () => [] };
  const registry = { get: () => { trace.push('credentials'); return provider; }, getEffectiveCapabilities: () => { throw new Error('must not rediscover capabilities'); } } as never;
  return { plan, registry, trace };
}

afterEach(() => { jest.useRealTimers(); jest.restoreAllMocks(); });

describe('shared LLM provider attempt', () => {
  it.each([undefined, null, {}, { prompt_tokens: null }, { completion_tokens: 0 }, { prompt_tokens_details: { cached_tokens: 0 } }])('retains Chat tool-result omission/zero semantics %#', async usage => {
    const value = fixture(); value.plan.adapter = selectLlmProtocolAdapter('openai-chat-completions');
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ choices: [{ message: { tool_calls: [{ id: 'call-usage', type: 'function', function: { name: 'done', arguments: '{}' } }] } }], usage })));
    const completion = await executeLlmProviderAttempt({ projectRoot: '.', registry: value.registry, plan: value.plan, capabilityRequest, options: options() });
    const expected = usage && 'completion_tokens' in usage ? { completion_tokens: 0 }
      : usage && 'prompt_tokens_details' in usage ? { cached_input_tokens: 0 } : undefined;
    expect(completion.result.kind).toBe('tool_calls');
    expect(completion.result.usage).toEqual(expected);
    expect(completion.provider_exchanges[0]).toMatchObject({ status: 'ok' });
    const evidence = completion.provider_exchanges[0]!;
    if (evidence.status !== 'ok') throw new Error('Expected successful exchange');
    expect(evidence.token_usage).toEqual(expected);
  });
  it.each(['openai-chat-completions', 'openai-responses'] as const)('projects real %s success usage without changing request bytes', async protocol => {
    const value = fixture(); value.plan.adapter = selectLlmProtocolAdapter(protocol);
    const usage = protocol === 'openai-responses'
      ? { input_tokens: 100, output_tokens: 10, total_tokens: 110, input_tokens_details: { cached_tokens: 40 }, output_tokens_details: { reasoning_tokens: 5 } }
      : { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110, prompt_tokens_details: { cached_tokens: 40 }, completion_tokens_details: { reasoning_tokens: 5 } };
    const payload = protocol === 'openai-responses'
      ? { status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'ok' }] }], usage }
      : { choices: [{ message: { content: 'ok' } }], usage };
    const fetch = jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify(payload)));
    const result = await executeLlmProviderAttempt({ projectRoot: '.', registry: value.registry, plan: value.plan, capabilityRequest, options: options() });
    const expected = { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110, cached_input_tokens: 40, reasoning_output_tokens: 5 };
    expect(result.result.usage).toEqual(expected);
    expect(result.provider_exchanges[0]).toMatchObject({ status: 'ok', token_usage: expected });
    expect(fetch.mock.calls[0]![1]!.body).toBe(value.plan.request.serializedBody);
  });
  it('keeps malformed Chat usage as safe existing parse failure, not successful evidence', async () => {
    const value = fixture(); value.plan.adapter = selectLlmProtocolAdapter('openai-chat-completions');
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }], usage: { prompt_tokens: 'private-secret' } })));
    const failure = await executeLlmProviderAttempt({ projectRoot: '.', registry: value.registry, plan: value.plan, capabilityRequest, options: options() }).catch(error => error);
    expect(failure.originalFailure.failure).toEqual({ kind: 'parse_error', provider: 'test', message: 'Invalid provider token usage at usage.prompt_tokens.' });
    expect(failure.provider_exchanges[0].status).toBe('error');
    expect(failure.provider_exchanges[0]).not.toHaveProperty('token_usage');
    expect(JSON.stringify(failure.provider_exchanges)).not.toContain('private-secret');
  });
  it.each(['openai-chat-completions', 'openai-responses', 'openai-codex-backend', 'error-body'] as const)('keeps exact owner body abort evidence for %s', async protocol => {
    jest.useFakeTimers();
    const owner = new AbortController(); const reason = new Error('body owner stopped');
    const value = fixture();
    if (protocol !== 'error-body') value.plan.adapter = { ...selectLlmProtocolAdapter(protocol), deriveWire: value.plan.adapter.deriveWire };
    let stream!: ReturnType<typeof controlledResponse>;
    jest.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => { stream = controlledResponse(init!.signal!, protocol === 'error-body' ? 503 : 200); return stream.response; });
    const pending = executeLlmProviderAttempt({ projectRoot: '.', registry: value.registry, plan: value.plan, capabilityRequest, options: options(owner.signal) }).catch(error => error);
    try {
      await jest.advanceTimersByTimeAsync(0);
      owner.abort(reason);
      expect(await pending).toMatchObject({ originalFailure: { failure: { kind: 'cancelled', reason: 'abort' } }, provider_exchanges: [{ status: 'error', error: { name: 'Error', message: 'body owner stopped' } }] });
      expect(stream.response.body!.locked).toBe(false);
      expect(jest.getTimerCount()).toBe(0);
    } finally {
      owner.abort(new Error('test cleanup'));
      stream?.close();
      await pending;
    }
  });
  it.each(['openai-chat-completions', 'openai-responses', 'error-body'] as const)('times out partial silent %s bodies without swallowing raw timeout evidence', async protocol => {
    jest.useFakeTimers();
    const owner = new AbortController();
    const value = fixture();
    if (protocol !== 'error-body') value.plan.adapter = selectLlmProtocolAdapter(protocol);
    let stream!: ReturnType<typeof controlledResponse>;
    jest.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      stream = controlledResponse(init!.signal!, protocol === 'error-body' ? 503 : 200);
      stream.send('{'); return stream.response;
    });
    const pending = executeLlmProviderAttempt({ projectRoot: '.', registry: value.registry, plan: value.plan, capabilityRequest, options: options(owner.signal) }).catch(error => error);
    try {
      await jest.advanceTimersByTimeAsync(120000);
      expect(await pending).toMatchObject({
        provider_exchanges: [{ status: 'error', error: { name: 'ProviderInactivityTimeoutError', message: 'Provider request inactive for 120000 ms.' } }],
        originalFailure: { failure: { kind: 'timeout' } },
      });
      expect((await pending).provider_exchanges).toHaveLength(1);
      expect(stream.response.body!.locked).toBe(false);
      expect(jest.getTimerCount()).toBe(0);
    } finally {
      owner.abort(new Error('test cleanup'));
      stream?.close();
      await pending;
    }
  });

  it('allows dispatched Codex data over several windows but never re-arms after valid completion', async () => {
    jest.useFakeTimers();
    const owner = new AbortController();
    const value = fixture(); value.plan.adapter = { ...selectLlmProtocolAdapter('openai-codex-backend'), deriveWire: value.plan.adapter.deriveWire };
    let stream!: ReturnType<typeof controlledResponse>;
    let effective!: AbortSignal;
    jest.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      effective = init!.signal!; stream = controlledResponse(effective); return stream.response;
    });
    const pending = executeLlmProviderAttempt({ projectRoot: '.', registry: value.registry, plan: value.plan, capabilityRequest, options: options(owner.signal) });
    try {
      await jest.advanceTimersByTimeAsync(0);
      for (let i = 0; i < 3; i++) {
        await jest.advanceTimersByTimeAsync(119000);
        stream.send('data: {"type":"response.output_text.delta","delta":"provisional"}\n\n');
        await jest.advanceTimersByTimeAsync(0);
      }
      await jest.advanceTimersByTimeAsync(119999);
      stream.send('data: {"type":"response.output_item.done","item":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"known success"}]}}\n\ndata: {"type":"response.completed","response":{"id":"r"}}\n\n');
      const completion = await pending;
      expect(completion).toMatchObject({ result: { kind: 'message', content: 'known success' }, provider_exchanges: [{ status: 'ok' }] });
      expect(stream.response.body!.locked).toBe(false);
      stream.close();
      await jest.advanceTimersByTimeAsync(240000);
      expect(effective.aborted).toBe(false);
      expect(jest.getTimerCount()).toBe(0);
    } finally {
      owner.abort(new Error('test cleanup'));
      stream?.close();
      await pending.catch(() => {});
    }
  });

  it.each([': keepalive\n\n', 'event: heartbeat\nunknown: field\n\n', 'data: {"type":'])( 'does not treat Codex framing traffic %p as activity', async traffic => {
    jest.useFakeTimers();
    const owner = new AbortController();
    const value = fixture(); value.plan.adapter = { ...selectLlmProtocolAdapter('openai-codex-backend'), deriveWire: value.plan.adapter.deriveWire };
    let stream!: ReturnType<typeof controlledResponse>;
    jest.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => { stream = controlledResponse(init!.signal!); return stream.response; });
    const pending = executeLlmProviderAttempt({ projectRoot: '.', registry: value.registry, plan: value.plan, capabilityRequest, options: options(owner.signal) }).catch(error => error);
    try {
      await jest.advanceTimersByTimeAsync(0);
      for (let i = 0; i < 3; i++) { await jest.advanceTimersByTimeAsync(30000); stream.send(traffic); await jest.advanceTimersByTimeAsync(0); }
      await jest.advanceTimersByTimeAsync(30000);
      expect(await pending).toMatchObject({ originalFailure: { failure: { kind: 'timeout' } }, provider_exchanges: [{ status: 'error', error: { name: 'ProviderInactivityTimeoutError' } }] });
      expect(stream.response.body!.locked).toBe(false);
      expect(jest.getTimerCount()).toBe(0);
    } finally {
      owner.abort(new Error('test cleanup'));
      stream?.close();
      await pending;
    }
  });

  it.each(['openai-chat-completions', 'openai-responses'] as const)('permits slowly arriving nonempty %s JSON bytes', async protocol => {
    jest.useFakeTimers();
    const owner = new AbortController();
    const value = fixture(); value.plan.adapter = selectLlmProtocolAdapter(protocol);
    let stream!: ReturnType<typeof controlledResponse>;
    jest.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => { stream = controlledResponse(init!.signal!); return stream.response; });
    const body = protocol === 'openai-responses'
      ? '{"id":"r","status":"completed","output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"ok"}]}]}'
      : '{"choices":[{"message":{"content":"ok"},"finish_reason":"stop"}]}';
    const pending = executeLlmProviderAttempt({ projectRoot: '.', registry: value.registry, plan: value.plan, capabilityRequest, options: options(owner.signal) });
    try {
      await jest.advanceTimersByTimeAsync(0);
      for (const chunk of [body.slice(0, 10), body.slice(10, 20), body.slice(20)]) {
        await jest.advanceTimersByTimeAsync(119000); stream.send(chunk); await jest.advanceTimersByTimeAsync(0);
      }
      stream.close();
      expect(await pending).toMatchObject({ result: { kind: 'message', content: 'ok' }, provider_exchanges: [{ status: 'ok' }] });
      expect(jest.getTimerCount()).toBe(0);
    } finally {
      owner.abort(new Error('test cleanup'));
      stream?.close();
      await pending.catch(() => {});
    }
  });
  it('fails fast for an impossible transport protocol', () => {
    expect(() => selectLlmProtocolAdapter('unexpected' as never)).toThrow("Unsupported LLM transport protocol 'unexpected'.");
  });

  it('fails an already cancelled attempt before credentials, wire derivation, or fetch', async () => {
    const reason = new Error('already stopped'); const controller = new AbortController(); controller.abort(reason); const value = fixture(); const fetchSpy = jest.spyOn(globalThis, 'fetch');
    await expect(executeLlmProviderAttempt({ projectRoot: '.', registry: value.registry, plan: value.plan, capabilityRequest, options: options(controller.signal) })).rejects.toBe(reason);
    expect(value.trace).toEqual([]); expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('throws the singular integrity error before capability, credentials, wire, recorder, or fetch', async () => {
    const value = fixture(); value.plan.request.serializedBody = '{"corrupt":true}'; const fetchSpy = jest.spyOn(globalThis, 'fetch');
    const pending = executeLlmProviderAttempt({ projectRoot: '.', registry: value.registry, plan: value.plan, capabilityRequest, options: options() });
    await expect(pending).rejects.toBeInstanceOf(CandidateRequestPlanIntegrityError); expect(value.trace).toEqual([]); expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('throws the internal admission-integrity error before credentials, wire, recorder, or fetch when the admitted binding no longer supports its request', async () => {
    const value = fixture(); value.plan.capabilities = { ...capabilities, toolsMode: 'unsupported' }; const opts = options(); opts.tools = [{ type: 'function', function: { name: 'x', description: 'x', parameters: {} } }]; const fetchSpy = jest.spyOn(globalThis, 'fetch');
    let rejection: unknown;
    try {
      await executeLlmProviderAttempt({ projectRoot: '.', registry: value.registry, plan: value.plan, capabilityRequest: { ...capabilityRequest, requiresTools: true }, options: opts });
      throw new Error('Expected admission integrity failure.');
    } catch (error) { rejection = error; }
    expect(rejection).toBeInstanceOf(AdmissionIntegrityError);
    expect(rejection).not.toBeInstanceOf(LlmRequestError);
    expect((rejection as LlmRequestError).failure).toBeUndefined();
    expect((rejection as AdmissionIntegrityError).message).toContain('no longer supports its bound capability request');
    expect(value.trace).toEqual([]); expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('admits with the explicit retained request instead of recomputing from transport options', async () => {
    const value = fixture();
    value.plan.capabilities = { ...capabilities, toolsMode: 'unsupported' };
    const opts = options();
    opts.tools = [{ type: 'function', function: { name: 'x', description: 'x', parameters: {} } }];
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 200 }));

    await expect(executeLlmProviderAttempt({ projectRoot: '.', registry: value.registry, plan: value.plan, capabilityRequest, options: opts }))
      .resolves.toMatchObject({ result: { kind: 'message', content: 'ok' } });
    expect(value.trace).toEqual(['credentials', 'wire']);
  });

  it('resolves credentials before wire derivation and settles one success with terminal evidence', async () => {
    const value = fixture({ parseSuccess: async () => ({ result: { kind: 'tool_calls', tool_calls: [{ id: '1', type: 'function', function: { name: 'done', arguments: '{}' } }], usage: { total_tokens: 2 } }, finishReason: 'tool_calls' }) });
    jest.spyOn(globalThis, 'fetch').mockImplementation(async () => { value.trace.push('fetch'); return new Response('{}', { status: 200 }); });
    const result = await executeLlmProviderAttempt({ projectRoot: '.', registry: value.registry, plan: value.plan, capabilityRequest, options: options() });
    expect(value.trace).toEqual(['credentials', 'wire', 'fetch']); expect(result.provider_exchanges).toHaveLength(1); expect(result.provider_exchanges[0]).toMatchObject({ status: 'ok', response_status: 200, terminal_tool_fired: 'done' });
  });

  it('retains exact wire bytes and known successful evidence when abort arrives during successful parsing', async () => {
    const controller = new AbortController(); const reason = new Error('stopped after provider success');
    const value = fixture({ parseSuccess: async () => { controller.abort(reason); return { result: { kind: 'message', content: 'known success' }, finishReason: 'stop' }; } });
    const wire = ' {"é":1,"A":2} \n';
    value.plan.request.serializedBody = wire;
    value.plan.request.requestHash = createHash('sha256').update(wire, 'utf8').digest('hex');
    const fetchSpy = jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 200 }));
    const result = await executeLlmProviderAttempt({ projectRoot: '.', registry: value.registry, plan: value.plan, capabilityRequest, options: options(controller.signal) });
    expect(fetchSpy.mock.calls[0]![1]!.body).toBe(wire);
    expect(result).toMatchObject({ result: { kind: 'message', content: 'known success' }, provider_exchanges: [{ status: 'ok', response_status: 200 }] });
    expect(result.provider_exchanges).toHaveLength(1);
    expect(controller.signal.aborted).toBe(true);
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
    await executeLlmProviderAttempt({ projectRoot: '.', registry: value.registry, plan: value.plan, capabilityRequest, options: options() });
    expect(capabilityReads).toBe(1);
    expect(value.trace).toEqual(['credentials', 'wire', 'fetch']);
  });

  it('records a raw fetch error before generic recovery classification', async () => {
    const value = fixture(); jest.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('socket closed'));
    await expect(executeLlmProviderAttempt({ projectRoot: '.', registry: value.registry, plan: value.plan, capabilityRequest, options: options() })).rejects.toMatchObject({ provider_exchanges: [{ status: 'error', error: { name: 'TypeError', message: 'socket closed' } }], originalFailure: { failure: { kind: 'unknown' } } });
  });

  it('records a non-Error throw with ordinary evidence before classifying it', async () => {
    const value = fixture();
    jest.spyOn(globalThis, 'fetch').mockRejectedValue('socket closed');
    await expect(executeLlmProviderAttempt({ projectRoot: '.', registry: value.registry, plan: value.plan, capabilityRequest, options: options() })).rejects.toMatchObject({
      provider_exchanges: [{ status: 'error', error: { name: 'Error', message: 'socket closed' } }],
      originalFailure: { failure: { kind: 'unknown', message: 'socket closed' } },
    });
  });

  it('records an identity-equal custom owner reason raw, then types cancellation without generic classification', async () => {
    const value = fixture(); const controller = new AbortController(); const reason = new Error('owner stopped'); jest.spyOn(globalThis, 'fetch').mockImplementation(async () => { controller.abort(reason); throw reason; });
    await expect(executeLlmProviderAttempt({ projectRoot: '.', registry: value.registry, plan: value.plan, capabilityRequest, options: options(controller.signal) })).rejects.toMatchObject({ provider_exchanges: [{ status: 'error', error: { name: 'Error', message: 'owner stopped' } }], originalFailure: { failure: { kind: 'cancelled', reason: 'abort' } } });
  });

  it('does not relabel a distinct error merely because the signal is aborted', async () => {
    const value = fixture(); const controller = new AbortController(); const reason = new Error('same'); const distinct = new Error('same'); jest.spyOn(globalThis, 'fetch').mockImplementation(async () => { controller.abort(reason); throw distinct; });
    await expect(executeLlmProviderAttempt({ projectRoot: '.', registry: value.registry, plan: value.plan, capabilityRequest, options: options(controller.signal) })).rejects.toMatchObject({ originalFailure: { failure: { kind: 'unknown' } } });
  });

  it('records typed HTTP status before exposing the same typed recovery failure', async () => {
    const value = fixture(); jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('bad', { status: 503 }));
    await expect(executeLlmProviderAttempt({ projectRoot: '.', registry: value.registry, plan: value.plan, capabilityRequest, options: options() })).rejects.toMatchObject({ provider_exchanges: [{ status: 'error', response_status: 503, error: { name: 'LlmRequestError', status: 503 } }], originalFailure: { failure: { kind: 'server_transient', status: 503 } } });
  });

  it('records a parser-produced typed failure exactly once before exposing it unchanged to recovery', async () => {
    const parseFailure = new LlmRequestError({ kind: 'server_transient', provider: 'test', status: 200, message: 'malformed provider payload' });
    const value = fixture({ parseSuccess: async () => { throw parseFailure; } });
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 200 }));
    await expect(executeLlmProviderAttempt({ projectRoot: '.', registry: value.registry, plan: value.plan, capabilityRequest, options: options() })).rejects.toMatchObject({
      provider_exchanges: [{ status: 'error', response_status: 200, error: { name: 'LlmRequestError', message: 'malformed provider payload', status: 200 } }],
      originalFailure: parseFailure,
    });
  });

  it('records a Codex-style typed SSE failure after HTTP 200 with no ok envelope', async () => {
    const streamFailure = new LlmRequestError({ kind: 'input_context_exhausted', provider: 'openai-codex', status: 200, message: 'context exhausted in stream' });
    const value = fixture({
      deriveWire: () => { value.trace.push('wire'); return { endpoint: 'https://provider.test/codex/responses', headers: {}, requestParams: {}, transport: 'codex' }; },
      parseSuccess: async () => { throw streamFailure; },
    });
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('data: failure\n\n', { status: 200, headers: { 'content-type': 'text/event-stream' } }));
    try {
      await executeLlmProviderAttempt({ projectRoot: '.', registry: value.registry, plan: value.plan, capabilityRequest, options: options() });
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

  it('passes the original streaming response and body directly to the parser', async () => {
    const fetchedResponse = new Response('data: original\n\n', {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    });
    let parserResponse: Response | undefined;
    let parserBody: string | undefined;
    const value = fixture({
      deriveWire: () => {
        value.trace.push('wire');
        return {
          endpoint: 'https://provider.test/codex/responses',
          headers: {},
          requestParams: {},
          transport: 'codex',
        };
      },
      parseSuccess: async (_candidate, response, _options, consumption) => {
        parserResponse = response;
        parserBody = await consumption.readText(response);
        return { result: { kind: 'message', content: 'ok' }, finishReason: 'stop' };
      },
    });
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(fetchedResponse);

    await executeLlmProviderAttempt({
      projectRoot: '.',
      registry: value.registry,
      plan: value.plan,
      capabilityRequest,
      options: options(),
    });

    expect(parserResponse).toBe(fetchedResponse);
    expect(parserBody).toBe('data: original\n\n');
  });

  it('keeps credential/setup failure pre-attempt with no fetch or adapter wire work', async () => {
    const value = fixture();
    value.registry = { get: () => undefined } as never;
    const fetchSpy = jest.spyOn(globalThis, 'fetch');
    await expect(executeLlmProviderAttempt({ projectRoot: '.', registry: value.registry, plan: value.plan, capabilityRequest, options: options() })).rejects.toMatchObject({ failure: { kind: 'local_setup_error', reason: 'missing_provider' } });
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
      await executeLlmProviderAttempt({ projectRoot: '.', registry: value.registry, plan: value.plan, capabilityRequest, options: options() });
      throw new Error('Expected provider attempt to fail.');
    } catch (error) {
      expect(classifications).toBe(1);
      expect((error as { provider_exchanges: unknown[] }).provider_exchanges).toHaveLength(1);
    }
  });
});
