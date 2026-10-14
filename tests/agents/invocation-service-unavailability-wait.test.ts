import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MemoryCandidateAvailability } from '../../src/agents/candidate-availability.js';
import { responsesProducerAccountId } from '../../src/agents/llm-openai-responses-account.js';
import { InvocationService, type InvocationRequest } from '../../src/agents/invocation-service.js';
import type { CandidateRequestPlan } from '../../src/contracts/index.js';
import { AdmittedProviderTurnFailure, ProviderTurnFailure, type ProviderTurnCompletion } from '../../src/contracts/index.js';
import type { Candidate } from '../../src/contracts/provider-candidate.js';
import type { ProviderExchangeAttempt } from '../../src/contracts/provider-exchange.js';
import { handleOpenAICodexEvent } from '../../src/agents/llm-codex-parser.js';
import { LlmRequestError } from '../../src/contracts/llm-failure.js';
import { NO_FRESHNESS_EFFECTS } from '../../src/contracts/index.js';
import { chatSuccess, invocationProviderRegistry, serverUnavailable } from '../helpers/invocation-provider-fixture.js';
import { makeCodexJwt } from '../helpers/llm-test-helpers.js';

const candidate: Candidate = { provider: 'p', account: null, model: 'm' };
const alternate: Candidate = { provider: 'alt', account: null, model: 'm-alt' };

function request(chain: Candidate[] = [candidate]): InvocationRequest {
  return {
    inputId: 'agent:planner:card:1',
    agentName: 'planner',
    sessionId: 'agent:planner:card',
    systemPrompt: 'system',
    providerConversation: { sourceSessionId: 'agent:planner:card', messages: [] },
    tools: [],
    terminalToolNames: [],
    modelParams: { temperature: 0, maxTokens: 2000 },
    capabilityRequest: {},
    routePass: {kind:'ordinary',candidateChain:chain},
  };
}

const roots: string[] = [];

async function invoke(service: InvocationService, value: InvocationRequest, signal?: AbortSignal): Promise<ProviderTurnCompletion> {
  const admission = service.preparePrimaryRequestAdmission(value);
  if (admission.kind !== 'admitted') throw new Error('Unexpected local admission failure in unavailability-wait test.');
  return service.executeAdmittedWithRecovery(admission, signal);
}

function service(args: { chain?: Candidate[]; availability?: MemoryCandidateAvailability } = {}): InvocationService {
  const chain = args.chain ?? [candidate];
  const projectRoot = mkdtempSync(join(tmpdir(), 'saivage-invoke-wait-'));
  roots.push(projectRoot);
  return new InvocationService({
    freshness: NO_FRESHNESS_EFFECTS,
    projectRoot,
    registry: invocationProviderRegistry(chain.length > 0 ? chain : [candidate]),
    candidateAvailability: args.availability ?? new MemoryCandidateAvailability(),
  });
}

afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe('InvocationService temporary LLM unavailability wait', () => {
  it('runs real Codex HTTP-200 overload terminals beyond four attempts and two hours on frozen bytes', async () => {
    jest.useFakeTimers({ now: 0 });
    const codex = { provider: 'openai-codex', account: null, model: 'gpt-5' };
    const availability = new MemoryCandidateAvailability();
    const bodies: string[] = [];
    const sentAt: number[] = [];
    const fetch = jest.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      bodies.push(init!.body as string); sentAt.push(Date.now());
      const event = bodies.length <= 20
        ? { type: 'error', error: { code: 'server_is_overloaded', message: 'busy' } }
        : { type: 'response.completed', response: { id: 'recovered-response' } };
      const message = bodies.length <= 20 ? '' : `data: ${JSON.stringify({ type: 'response.output_item.done', item: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'recovered' }] } })}\n\n`;
      return new Response(`${message}data: ${JSON.stringify(event)}\n\n`, { status: 200 });
    });
    const svc = new InvocationService({ projectRoot: mkdtempRoot(), freshness: NO_FRESHNESS_EFFECTS, candidateAvailability: availability,
      registry: invocationProviderRegistry([codex], { 'openai-codex': { transportProtocol: 'openai-codex-backend', exclusiveToolChoiceSupport: 'parallel_off' } }, { 'openai-codex': makeCodexJwt('test-account') }) });
    let settled = false;
    const pending = invoke(svc, request([codex])).then(result => { settled = true; return result; });
    await jest.advanceTimersByTimeAsync(0);
    const delays = [30_000, 60_000, 120_000, 240_000, 480_000, ...Array<number>(15).fill(600_000)];
    for (const [index, delay] of delays.entries()) {
      expect(settled).toBe(false);
      expect(fetch).toHaveBeenCalledTimes(index + 1);
      expect(availability.getEntry(codex)).toMatchObject({ reason: 'server_overloaded', untilMs: Date.now() + delay });
      await jest.advanceTimersByTimeAsync(delay - 1);
      expect(fetch).toHaveBeenCalledTimes(index + 1);
      await jest.advanceTimersByTimeAsync(1);
    }
    const completion = await pending;
    expect(Date.now()).toBeGreaterThan(7_200_000);
    expect(completion.result).toMatchObject({ kind: 'message', content: 'recovered' });
    expect(completion.provider_exchanges).toHaveLength(21);
    completion.provider_exchanges.forEach((attempt, index) => expect(attempt).toMatchObject({ source_input_id: request().inputId, attempt_index: index, response_status: 200 }));
    expect(new Set(bodies).size).toBe(1);
    expect(sentAt.slice(1).map((time, index) => time - sentAt[index]!)).toEqual(delays);
    expect(jest.getTimerCount()).toBe(0);
  });

  it.each(['success', 'rate_limit', 'transient', 'auth'] as const)('tries admitted B promptly after A overload; B %s respects local overload authority', async outcome => {
    jest.useFakeTimers({ now: 0 });
    const sent: string[] = [];
    let aCalls = 0;
    jest.spyOn(globalThis, 'fetch').mockImplementation(async url => {
      const provider = new URL(String(url)).hostname.split('.')[0]!; sent.push(provider);
      if (provider === 'p') {
        aCalls++;
        if (aCalls <= 6) return new Response(JSON.stringify({ error: { code: 'overloaded' } }), { status: 503 });
        return chatSuccess('A recovered');
      }
      if (outcome === 'success') return chatSuccess('B recovered');
      if (outcome === 'auth') return new Response('{}', { status: 401 });
      if (outcome === 'rate_limit') return new Response('{}', { status: 429, headers: { 'retry-after': '20000' } });
      return serverUnavailable();
    });
    const pending = invoke(service({ chain: [candidate, alternate] }), request([candidate, alternate]));
    const observed = pending.catch(error => error);
    await jest.advanceTimersByTimeAsync(0);
    expect(sent.slice(0, 2)).toEqual(['p', 'alt']);
    if (outcome === 'auth') expect(await observed).toMatchObject({ originalFailure: { failure: { kind: 'auth_permanent' } } });
    else {
      if (outcome !== 'success') await jest.advanceTimersByTimeAsync(1_530_000);
      expect(await observed).toMatchObject({ result: { kind: 'message', content: outcome === 'success' ? 'B recovered' : 'A recovered' } });
      if (outcome === 'transient') expect(sent.filter(p => p === 'alt')).toHaveLength(4);
    }
    expect(jest.getTimerCount()).toBe(0);
  });

  it('uses oldest-due overload order and does not let a newly cooled earlier route jump a ready later route', async () => {
    jest.useFakeTimers({ now: 0 });
    const sent: string[] = [];
    jest.spyOn(globalThis, 'fetch').mockImplementation(async url => {
      const provider = new URL(String(url)).hostname.split('.')[0]!; sent.push(provider);
      return sent.length <= 5 ? new Response(JSON.stringify({ error: { code: 'overloaded' } }), { status: 503 }) : chatSuccess('done');
    });
    const pending = invoke(service({ chain: [candidate, alternate] }), request([candidate, alternate]));
    await jest.advanceTimersByTimeAsync(90_000);
    await pending;
    expect(sent).toEqual(['p', 'alt', 'p', 'alt', 'p', 'alt']);
  });

  it('loses overload authority on later finite failures and counts only four finite failures', async () => {
    jest.useFakeTimers({ now: 0 });
    const fetch = jest.spyOn(globalThis, 'fetch').mockImplementation(async () => fetch.mock.calls.length <= 6
      ? new Response(JSON.stringify({ error: { code: 'overloaded' } }), { status: 503 }) : serverUnavailable());
    const caught = invoke(service(), request()).catch(error => error);
    await jest.advanceTimersByTimeAsync(1_710_000);
    expect(await caught).toMatchObject({ originalFailure: { failure: { kind: 'server_transient' } }, provider_exchanges: expect.any(Array) });
    expect(fetch).toHaveBeenCalledTimes(10);
    expect(jest.getTimerCount()).toBe(0);
  });

  it.each(['server_transient', 'rate_limit', 'auth_permanent', 'content_policy', 'timeout'] as const)('does not grant a later %s unlimited recovery after the finite wait horizon', async kind => {
    jest.useFakeTimers({ now: 0 });
    const fetch = jest.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      if (fetch.mock.calls.length <= 20) return new Response(JSON.stringify({ error: { code: 'overloaded' } }), { status: 503 });
      if (kind === 'timeout') throw new Error('ETIMEDOUT');
      return new Response(JSON.stringify({ error: { code: kind === 'content_policy' ? 'content_filter' : 'other' } }),
        { status: kind === 'rate_limit' ? 429 : kind === 'auth_permanent' ? 401 : kind === 'content_policy' ? 400 : 503 });
    });
    const caught = invoke(service(), request()).catch(error => error);
    await jest.advanceTimersByTimeAsync(9_930_000);
    expect(await caught).toMatchObject({ originalFailure: { failure: { kind } } });
    expect(fetch).toHaveBeenCalledTimes(21);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('does not inherit unlimited overload authority from shared availability on a fresh invocation', async () => {
    jest.useFakeTimers({ now: 0 });
    const availability = new MemoryCandidateAvailability();
    availability.markFailed(candidate, { state: 'COOLING', untilMs: 10_800_000, reason: 'server_overloaded' });
    const fetch = jest.spyOn(globalThis, 'fetch');
    const caught = invoke(service({ availability }), request()).catch(error => error);
    await jest.advanceTimersByTimeAsync(7_200_000);
    expect(await caught).toBeInstanceOf(ProviderTurnFailure);
    expect(fetch).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(0);
  });

  it('retains finite accounting and overload due/backoff through another candidate context suspension', async () => {
    jest.useFakeTimers({ now: 0 });
    const availability = new MemoryCandidateAvailability();
    const sent: Array<[string, number]> = [];
    let aCalls = 0; let bCalls = 0;
    jest.spyOn(globalThis, 'fetch').mockImplementation(async url => {
      const provider = new URL(String(url)).hostname.split('.')[0]!; sent.push([provider, Date.now()]);
      if (provider === 'p') {
        aCalls++;
        return aCalls <= 2 ? new Response(JSON.stringify({ error: { code: 'overloaded' } }), { status: 503 }) : chatSuccess('A recovered');
      }
      bCalls++;
      return bCalls === 1 ? new Response(JSON.stringify({ error: { code: 'context_length_exceeded' } }), { status: 400 })
        : new Response('{}', { status: 429, headers: { 'retry-after': '20000' } });
    });
    const svc = service({ chain: [candidate, alternate], availability });
    const caught = await invoke(svc, request([candidate, alternate])).catch(error => error);
    expect(caught).toBeInstanceOf(AdmittedProviderTurnFailure);
    const suspension = (caught as AdmittedProviderTurnFailure).suspension;
    expect(suspension.records.map(record => record.state)).toMatchObject([
      { kind: 'retry_waiting', wait: 'overload', attempts: 1, finiteFailures: 0, untilMs: 30_000, overloadDelayMs: 60_000 },
      { kind: 'context_failed', attempts: 1, finiteFailures: 1, overloadDelayMs: 30_000 },
    ]);
    const preparation = svc.prepareAdmittedRecovery({ suspension, request: request([candidate, alternate]) });
    const pending = svc.resumeAdmittedExecution(preparation);
    await jest.advanceTimersByTimeAsync(90_000);
    expect((await pending).result).toMatchObject({ kind: 'message', content: 'A recovered' });
    expect(sent).toEqual([['p',0], ['alt',0], ['alt',0], ['p',30_000], ['p',90_000]]);
  });

  it.each([false, true])('expires a finite alternative at two hours without zero-delay spin or killing pending overload (shared initial wait=%s)', async sharedInitialWait => {
    jest.useFakeTimers({ now: 0 });
    const availability = new MemoryCandidateAvailability();
    if (sharedInitialWait) availability.markFailed(alternate, { state: 'COOLING', reason: 'server_overloaded', untilMs: 7_300_000 });
    const sent: Array<[string, number]> = [];
    let aCalls = 0;
    jest.spyOn(globalThis, 'fetch').mockImplementation(async url => {
      const provider = new URL(String(url)).hostname.split('.')[0]!; sent.push([provider, Date.now()]);
      if (provider === 'alt') return new Response('{}', { status: 429, headers: { 'retry-after': '20000' } });
      aCalls++;
      return aCalls <= 20 ? new Response(JSON.stringify({ error: { code: 'overloaded' } }), { status: 503 }) : chatSuccess('A recovered');
    });
    const pending = invoke(service({ chain: [candidate, alternate], availability }), request([candidate, alternate]));
    await jest.advanceTimersByTimeAsync(9_930_000);
    expect((await pending).result).toMatchObject({ kind: 'message', content: 'A recovered' });
    expect(sent.filter(([provider]) => provider === 'alt')).toEqual(sharedInitialWait ? [] : [['alt',0]]);
    expect(sent).toHaveLength(sharedInitialWait ? 21 : 22);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('cancels local overload delay with exact reason and no later send or availability mutation', async () => {
    jest.useFakeTimers({ now: 0 });
    const controller = new AbortController();
    const reason = new Error('stop overload');
    const availability = new MemoryCandidateAvailability();
    const failed = jest.spyOn(availability, 'markFailed');
    const fetch = jest.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify({ error: { code: 'overloaded' } }), { status: 503 }));
    const caught = invoke(service({ availability }), request([candidate]), controller.signal).catch(error => error);
    await jest.advanceTimersByTimeAsync(0);
    controller.abort(reason);
    expect(await caught).toBe(reason);
    await jest.advanceTimersByTimeAsync(600_000);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(failed).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
  });

  it.each([503, 403, 429])('applies truthful HTTP %s plus Retry-After to real availability and retry selection', async (status) => {
    jest.useFakeTimers({ now: 1000 });
    const availability = new MemoryCandidateAvailability();
    const svc = service({ chain: [candidate, alternate], availability });
    const fetch = jest.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('{}', { status, headers: { 'retry-after': '120' } }))
      .mockResolvedValue(chatSuccess('healthy alternate'));
    if (status === 403) {
      await expect(invoke(svc, request([candidate, alternate]))).rejects.toMatchObject({ originalFailure: { failure: { kind: 'auth_permanent', status: 403 } }, provider_exchanges: [{ response_status: 403 }] });
      expect(fetch).toHaveBeenCalledTimes(1);
    } else {
      const completion = await invoke(svc, request([candidate, alternate]));
      expect(completion.provider_exchanges[0]).toMatchObject({ response_status: status });
      expect(fetch).toHaveBeenCalledTimes(2);
    }
    expect(availability.getEntry(candidate)).toMatchObject(status === 503
      ? { state: 'COOLING', untilMs: 61000, reason: 'server_transient' }
      : status === 403
        ? { state: 'BLOCKED_UNTIL', untilMs: 3601000, reason: 'auth_permanent' }
        : { state: 'BLOCKED_UNTIL', untilMs: 121000, reason: 'rate_limit' });
  });
  it.each([
    [new DOMException('stream stopped', 'AbortError'), false],
    [Object.assign(new Error('stream stopped'), { name: 'AbortError' }), false],
    [new Error('custom owner stopped'), true],
  ] satisfies Array<[Error | DOMException, boolean]>)('preserves actual Codex adapter/runner stream cancellation evidence without retry or availability effects: %p', async (reason, abortOwner) => {
    jest.useFakeTimers({ now: 0 });
    const codex = { provider: 'openai-codex', account: null, model: 'gpt-5' };
    const availability = new MemoryCandidateAvailability();
    const failed = jest.spyOn(availability, 'markFailed');
    const succeeded = jest.spyOn(availability, 'markSucceeded');
    const controller = new AbortController();
    let firstBody!: ReadableStream<Uint8Array>;
    const fetch = jest.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      firstBody = new ReadableStream<Uint8Array>({ pull(streamController) {
        if (abortOwner) controller.abort(reason);
        streamController.error(reason);
      } }, { highWaterMark: 0 });
      return new Response(firstBody, { status: 200 });
    });
    const svc = new InvocationService({ projectRoot: mkdtempRoot(), freshness: NO_FRESHNESS_EFFECTS, candidateAvailability: availability,
      registry: invocationProviderRegistry([codex], { 'openai-codex': { transportProtocol: 'openai-codex-backend', exclusiveToolChoiceSupport: 'parallel_off' } }, { 'openai-codex': makeCodexJwt('test-account') }) });
    let caught: unknown;
    const pending = invoke(svc, request([codex]), controller.signal).catch((error: unknown) => { caught = error; });
    await jest.advanceTimersByTimeAsync(0);
    expect(caught).toMatchObject({
      originalFailure: { failure: { kind: 'cancelled', reason: 'abort' } },
      provider_exchanges: [{ attempt_index: 0, status: 'error', error: { name: reason instanceof Error ? reason.name : 'Error', message: reason instanceof Error ? reason.message : String(reason) } }],
    });
    await pending;
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(firstBody.locked).toBe(false);
    expect(failed).not.toHaveBeenCalled();
    expect(succeeded).not.toHaveBeenCalled();
  });

  it('sends to a healthy untried alternate immediately after a real primary 503, preserving ordered evidence', async () => {
    jest.useFakeTimers({ now: 0 });
    const fetch = jest.spyOn(globalThis, 'fetch').mockResolvedValueOnce(serverUnavailable()).mockResolvedValueOnce(chatSuccess('alternate'));
    const pending = invoke(service({ chain: [candidate, alternate] }), request([candidate, alternate]));
    await jest.advanceTimersByTimeAsync(0);
    expect(fetch).toHaveBeenCalledTimes(2);
    await expect(pending).resolves.toMatchObject({ result: { kind: 'message', content: 'alternate' }, provider_exchanges: [
      { attempt_index: 0, provider: 'p', status: 'error', error: { status: 503 } },
      { attempt_index: 1, provider: 'alt', status: 'ok' },
    ] });
    expect(Date.now()).toBe(0);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('keeps a real earlier Codex 503 before an identity-equal stream cancellation with no later retry or availability mutation', async () => {
    jest.useFakeTimers({ now: 0 });
    const codex = { provider: 'openai-codex', account: null, model: 'gpt-5' };
    const availability = new MemoryCandidateAvailability();
    const failed = jest.spyOn(availability, 'markFailed');
    const succeeded = jest.spyOn(availability, 'markSucceeded');
    const controller = new AbortController();
    const reason = new Error('stream owner stopped');
    let body!: ReadableStream<Uint8Array>;
    const fetch = jest.spyOn(globalThis, 'fetch').mockResolvedValueOnce(serverUnavailable()).mockImplementationOnce(async () => {
      body = new ReadableStream<Uint8Array>({ pull(streamController) { controller.abort(reason); streamController.error(reason); } }, { highWaterMark: 0 });
      return new Response(body, { status: 200 });
    });
    const svc = new InvocationService({ projectRoot: mkdtempRoot(), freshness: NO_FRESHNESS_EFFECTS, candidateAvailability: availability,
      registry: invocationProviderRegistry([codex], { 'openai-codex': { transportProtocol: 'openai-codex-backend', exclusiveToolChoiceSupport: 'parallel_off' } }, { 'openai-codex': makeCodexJwt('test-account') }) });
    const pending = invoke(svc, request([codex]), controller.signal);
    const rejection = expect(pending).rejects.toMatchObject({ originalFailure: { failure: { kind: 'cancelled', reason: 'abort' } }, provider_exchanges: [
      { attempt_index: 0, status: 'error', error: { status: 503 } },
      { attempt_index: 1, status: 'error', error: { name: 'Error', message: reason.message } },
    ] });
    await jest.advanceTimersByTimeAsync(60_000);
    await rejection;
    expect(body.locked).toBe(false);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(failed).toHaveBeenCalledTimes(1);
    expect(succeeded).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(0);
  });

  it.each(['ordinary', 'pinned'] as const)('retains successful Responses result/private context and indexed evidence through racing abort: %s', async (route) => {
    jest.useFakeTimers({ now: 0 });
    const availability = new MemoryCandidateAvailability();
    const succeeded = jest.spyOn(availability, 'markSucceeded');
    const controller = new AbortController();
    const output = [{ type: 'reasoning', id: 'rs-1', encrypted_content: 'opaque' }, { type: 'message', id: 'msg-1', content: [{ type: 'output_text', text: 'known' }] }];
    let release!: (response: Response) => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const fetch = jest.spyOn(globalThis, 'fetch');
    if (route === 'ordinary') fetch.mockResolvedValueOnce(serverUnavailable());
    fetch.mockImplementation(() => new Promise((resolve) => { release = resolve; entered(); }));
    const svc = new InvocationService({ projectRoot: mkdtempRoot(), freshness: NO_FRESHNESS_EFFECTS, candidateAvailability: availability, registry: invocationProviderRegistry([candidate], { p: { transportProtocol: 'openai-responses' } }) });
    let pending: Promise<ProviderTurnCompletion>;
    if (route === 'ordinary') pending = invoke(svc, request([candidate]), controller.signal);
    else {
      const preflight = svc.preflightPinnedContentPolicyRequest({ ...request([candidate]), routePass: { kind: 'pinned-content-policy-retry', candidate } });
      if (preflight.kind !== 'admitted') throw new Error('Expected admitted pinned request.');
      pending = svc.executePinnedContentPolicyRequest(preflight, { attemptIndex: 0 }, controller.signal);
    }
    await jest.advanceTimersByTimeAsync(route === 'ordinary' ? 60_000 : 0);
    await started;
    controller.abort(new Error('owner stopped'));
    release(new Response(JSON.stringify({ status: 'completed', output }), { status: 200 }));
    const expectedAttempts = route === 'ordinary'
      ? [{ source_input_id: 'agent:planner:card:1', attempt_index: 0, status: 'error' }, { source_input_id: 'agent:planner:card:1', attempt_index: 1, status: 'ok' }]
      : [{ source_input_id: 'agent:planner:card:1', attempt_index: 0, status: 'ok' }];
    await expect(pending).resolves.toMatchObject({ result: { kind: 'message', content: 'known' }, provider_private_context: { kind: 'openai_responses', producer_account_id: responsesProducerAccountId(candidate), source_input_id: 'agent:planner:card:1', provider: 'p', model: 'm', output }, provider_exchanges: expectedAttempts });
    expect(fetch).toHaveBeenCalledTimes(route === 'ordinary' ? 2 : 1);
    expect(succeeded).not.toHaveBeenCalled();
  });

  it('indexes an identity-equal owner cancellation without retry or availability mutation', async () => {
    const availability = new MemoryCandidateAvailability();
    const markFailed = jest.spyOn(availability, 'markFailed');
    const markSucceeded = jest.spyOn(availability, 'markSucceeded');
    const controller = new AbortController();
    const reason = new Error('owner stopped');
    const fetch = jest.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      controller.abort(reason);
      throw init?.signal?.reason;
    });
    const invocation = invoke(service({ availability }), request([candidate]), controller.signal);

    await expect(invocation).rejects.toMatchObject({
      originalFailure: { failure: { kind: 'cancelled', reason: 'abort' } },
      provider_exchanges: [{ source_input_id: 'agent:planner:card:1', attempt_index: 0, status: 'error', error: { name: 'Error', message: 'owner stopped' } }],
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(markFailed).not.toHaveBeenCalled();
    expect(markSucceeded).not.toHaveBeenCalled();
  });

  it('keeps earlier retry evidence before a final indexed owner cancellation without another availability mutation', async () => {
    jest.useFakeTimers({ now: 0 });
    const availability = new MemoryCandidateAvailability();
    const markFailed = jest.spyOn(availability, 'markFailed');
    const markSucceeded = jest.spyOn(availability, 'markSucceeded');
    const controller = new AbortController();
    const reason = new Error('owner stopped');
    const bodies: string[] = [];
    const fetch = jest.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      bodies.push(init?.body as string);
      if (fetch.mock.calls.length === 1) return serverUnavailable();
      controller.abort(reason);
      throw init?.signal?.reason;
    });
    const invocation = invoke(service({ availability }), request([candidate]), controller.signal);

    const rejection = expect(invocation).rejects.toMatchObject({
      provider_exchanges: [
        { attempt_index: 0, error: { message: expect.stringContaining('try again'), status: 503 } },
        { attempt_index: 1, error: { name: 'Error', message: 'owner stopped' } },
      ],
    });
    await jest.advanceTimersByTimeAsync(60_000);
    await rejection;
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(bodies).toHaveLength(2);
    expect(bodies[1]).toBe(bodies[0]);
    expect(markFailed).toHaveBeenCalledTimes(1);
    expect(markSucceeded).not.toHaveBeenCalled();
  });

  it('returns a known late success without a late availability update after its owner closes', async () => {
    const availability = new MemoryCandidateAvailability();
    const controller = new AbortController();
    let release!: (value: Response) => void;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    jest.spyOn(globalThis, 'fetch').mockImplementation(() => new Promise((resolve) => {
      release = resolve;
      markStarted();
    }));
    const pending = invoke(service({ availability }), request([candidate]), controller.signal);
    await started;
    controller.abort(new Error('owner stopped'));
    release(chatSuccess('late'));
    await expect(pending).resolves.toMatchObject({ result: { kind: 'message', content: 'late' }, provider_exchanges: [{ attempt_index: 0, status: 'ok' }] });
    expect(availability.getEntry(candidate)).toBeUndefined();
  });

  it('waits and retries after a temporary failed candidate cools down', async () => {
    jest.useFakeTimers({ now: 0 });
    const bodies: string[] = [];
    const fetch = jest.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      bodies.push(init?.body as string);
      return fetch.mock.calls.length === 1 ? serverUnavailable() : chatSuccess('ok');
    });
    const invocation = invoke(service(), request());

    await jest.advanceTimersByTimeAsync(60_000);

    await expect(invocation).resolves.toMatchObject({ result: { kind: 'message', content: 'ok' } });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(bodies).toHaveLength(2);
    expect(bodies[1]).toBe(bodies[0]);
  });

  it('terminates after four pre-provider transient attempts without waiting for the exhausted candidate cooldown', async () => {
    jest.useFakeTimers({ now: 0 });
    const availability = new MemoryCandidateAvailability();
    const failure = new LlmRequestError({ kind: 'server_transient', provider: 'p', status: 0, message: 'refresh unavailable' });
    let calls = 0;
    class ScriptedService extends InvocationService {
      override async executeAdmittedPlan(): Promise<ProviderTurnCompletion> {
        calls++;
        throw failure;
      }
    }
    const scripted = new ScriptedService({ projectRoot: mkdtempRoot(), freshness: NO_FRESHNESS_EFFECTS, registry: invocationProviderRegistry([candidate]), candidateAvailability: availability });
    const pending = invoke(scripted, request());
    const rejection = pending.then(
      () => { throw new Error('Expected exhausted pre-provider attempts to reject.'); },
      (error: unknown) => error,
    );

    await jest.advanceTimersByTimeAsync(60_000);
    await jest.advanceTimersByTimeAsync(60_000);
    await jest.advanceTimersByTimeAsync(60_000);

    const caught = await rejection;
    expect(caught).toBeInstanceOf(ProviderTurnFailure);
    expect(caught).toMatchObject({ failure_phase: 'pre_provider', provider_exchanges: [] });
    expect((caught as ProviderTurnFailure).originalFailure).toBe(failure);
    expect(calls).toBe(4);
    expect(Date.now()).toBe(180_000);
    expect(availability.getEntry(candidate)).toMatchObject({ state: 'COOLING', untilMs: 240_000, reason: 'server_transient' });
    expect(jest.getTimerCount()).toBe(0);
  });

  it('selects an alternative immediately after a primary pre-provider transient and retains only real exchange evidence', async () => {
    jest.useFakeTimers({ now: 0 });
    const availability = new MemoryCandidateAvailability();
    const failure = new LlmRequestError({ kind: 'server_transient', provider: 'p', status: 0, message: 'refresh unavailable' });
    const seen: Candidate[] = [];
    class ScriptedService extends InvocationService {
      override async executeAdmittedPlan(plan: CandidateRequestPlan): Promise<ProviderTurnCompletion> {
        seen.push(plan.candidate);
        if (plan.candidate.provider === candidate.provider) throw failure;
        return { result: { kind: 'message', content: 'alternative succeeded' }, provider_exchanges: [exchange('unindexed', 8, 'ok', alternate)] };
      }
    }
    const scripted = new ScriptedService({ projectRoot: mkdtempRoot(), freshness: NO_FRESHNESS_EFFECTS, registry: invocationProviderRegistry([candidate, alternate]), candidateAvailability: availability });
    const pending = invoke(scripted, request([candidate, alternate]));

    await jest.advanceTimersByTimeAsync(0);
    expect(seen).toEqual([candidate, alternate]);

    await expect(pending).resolves.toMatchObject({
      result: { kind: 'message', content: 'alternative succeeded' },
      provider_exchanges: [{ source_input_id: 'agent:planner:card:1', attempt_index: 0, status: 'ok', provider: 'alt', model: 'm-alt' }],
    });
    expect(availability.getEntry(candidate)).toMatchObject({ state: 'COOLING', untilMs: 60_000, reason: 'server_transient' });
    expect(jest.getTimerCount()).toBe(0);
  });

  it('retries exact Codex server_is_overloaded on one fixed candidate and indexes error then success', async () => {
    jest.useFakeTimers({ now: 0 });
    const projectRoot = mkdtempSync(join(tmpdir(), 'saivage-overload-recovery-'));
    roots.push(projectRoot);
    const seen: Candidate[] = [];
    let calls = 0;
    class ScriptedService extends InvocationService {
      override async executeAdmittedPlan(plan: CandidateRequestPlan): Promise<ProviderTurnCompletion> {
        seen.push(plan.candidate);
        calls++;
        if (calls === 1) {
          const originalFailure = codexOverloadFailure();
          throw new ProviderTurnFailure({ failure_phase: 'provider_attempt', provider_exchanges: [exchange('unindexed', 7, 'error')], originalFailure, candidate: plan.candidate });
        }
        return { result: { kind: 'message', content: 'summary recovered' }, provider_exchanges: [exchange('unindexed', 9, 'ok')] };
      }
    }
    const scripted = new ScriptedService({ projectRoot, freshness: NO_FRESHNESS_EFFECTS, registry: invocationProviderRegistry([candidate]), candidateAvailability: new MemoryCandidateAvailability() });
    const pending = invoke(scripted, request([candidate]));

    await jest.advanceTimersByTimeAsync(60_000);

    await expect(pending).resolves.toMatchObject({ result: { kind: 'message', content: 'summary recovered' }, provider_exchanges: [{ source_input_id: 'agent:planner:card:1', attempt_index: 0, status: 'error' }, { source_input_id: 'agent:planner:card:1', attempt_index: 1, status: 'ok' }] });
    expect(seen).toEqual([candidate, candidate]);
  });

  it('waits when the only candidate is already cooling, then invokes it after the horizon', async () => {
    jest.useFakeTimers({ now: 0 });
    const availability = new MemoryCandidateAvailability();
    availability.markFailed(candidate, { state: 'COOLING', untilMs: 60_000, reason: 'server_transient' });
    const fetch = jest.spyOn(globalThis, 'fetch').mockResolvedValue(chatSuccess('ok'));
    const invocation = invoke(service({ availability }), request());

    await jest.advanceTimersByTimeAsync(59_999);
    expect(fetch).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(1);

    await expect(invocation).resolves.toMatchObject({ result: { kind: 'message', content: 'ok' } });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('fails after the fixed two-hour timeout when a temporary candidate never becomes usable', async () => {
    jest.useFakeTimers({ now: 0 });
    const availability = new MemoryCandidateAvailability();
    availability.markFailed(candidate, { state: 'COOLING', untilMs: 3 * 60 * 60 * 1000, reason: 'server_transient' });
    const invocation = invoke(service({ availability }), request());
    const rejection = expect(invocation).rejects.toThrow("No LLM candidate became available for agent 'planner' within 7200000ms.");

    await jest.advanceTimersByTimeAsync(2 * 60 * 60 * 1000);

    await rejection;
  });

  it('does not wait when no configured or capability-compatible candidates exist', async () => {
    const admission = service({ chain: [] }).preparePrimaryRequestAdmission({ ...request([]), routePass: { kind: 'ordinary', candidateChain: [] } });
    expect(admission.kind).toBe('local_admission_failed');
  });

  it('does not wait for auth-permanent-only unavailability', async () => {
    jest.useFakeTimers({ now: 0 });
    const availability = new MemoryCandidateAvailability();
    availability.markFailed(candidate, { state: 'BLOCKED_UNTIL', untilMs: 60_000, reason: 'auth_permanent' });

    await expect(invoke(service({ availability }), request())).rejects.toThrow("No healthy candidates available for agent 'planner'.");
    expect(jest.getTimerCount()).toBe(0);
  });

  it('tries an available alternate before waiting for a cooled primary', async () => {
    jest.useFakeTimers({ now: 0 });
    const availability = new MemoryCandidateAvailability();
    availability.markFailed(candidate, { state: 'COOLING', untilMs: 60_000, reason: 'server_transient' });
    const seen: string[] = [];
    jest.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const provider = new URL(String(input)).hostname.split('.')[0]!;
      seen.push(provider);
      return chatSuccess(provider);
    });
    const completion = await invoke(service({ availability, chain: [candidate, alternate] }), request([candidate, alternate]));

    expect(completion.result).toMatchObject({ kind: 'message', content: 'alt' });
    expect(seen).toEqual(['alt']);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('propagates aborts during an availability wait without wrapping them', async () => {
    jest.useFakeTimers({ now: 0 });
    const availability = new MemoryCandidateAvailability();
    availability.markFailed(candidate, { state: 'COOLING', untilMs: 60_000, reason: 'server_transient' });
    const controller = new AbortController();
    const reason = new Error('stop');
    const invocation = invoke(service({ availability }), request([candidate]), controller.signal);

    controller.abort(reason);

    await expect(invocation).rejects.toBe(reason);
  });
});

function codexOverloadFailure(): LlmRequestError {
  try {
    handleOpenAICodexEvent(JSON.stringify({ type: 'error', error: { code: 'server_is_overloaded', message: 'busy' } }), 200, new Map(), new Set(), [], () => { throw new Error('Unexpected completed message.'); }, () => { throw new Error('Unexpected terminal usage.'); });
  } catch (error) {
    if (error instanceof LlmRequestError) return error;
    throw error;
  }
  throw new Error('Expected exact Codex overload event to fail.');
}

function exchange(source_input_id: string, attempt_index: number, status: 'ok' | 'error', identity: Candidate = candidate): ProviderExchangeAttempt {
  const common = { contract_id: 'test.v1', contract_name: 'test', transport: 'generic' as const, provider: identity.provider, model: identity.model, source_input_id, attempt_index, request_params: { endpoint: 'https://example.invalid', method: 'POST', stream: false, offered_tools_count: 0, temperature: 0, max_tokens: 10 }, started_at: '2026-08-10T00:00:00.000Z', completed_at: '2026-08-10T00:00:01.000Z', terminal_tool_fired: null };
  return status === 'ok' ? { ...common, status } : { ...common, status, error: { name: 'LlmRequestError', message: 'busy' } };
}

function mkdtempRoot(): string {
  const projectRoot = mkdtempSync(join(tmpdir(), 'saivage-invoke-wait-'));
  roots.push(projectRoot);
  return projectRoot;
}
