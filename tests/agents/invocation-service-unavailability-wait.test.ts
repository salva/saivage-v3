import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MemoryCandidateAvailability } from '../../src/agents/candidate-availability.js';
import { InvocationService, type InvocationRequest } from '../../src/agents/invocation-service.js';
import type { CandidateRequestPlan } from '../../src/agents/candidate-request.js';
import { ProviderTurnFailure, type ProviderTurnCompletion } from '../../src/agents/llm-contracts.js';
import type { Candidate } from '../../src/contracts/provider-candidate.js';
import type { ProviderExchangeAttempt } from '../../src/contracts/provider-exchange.js';
import { handleOpenAICodexEvent } from '../../src/agents/llm-codex-parser.js';
import { LlmRequestError } from '../../src/contracts/llm-failure.js';
import { NO_FRESHNESS_EFFECTS } from '../../src/application/freshness-effects.js';
import { chatSuccess, invocationProviderRegistry, serverUnavailable } from '../helpers/invocation-provider-fixture.js';

const candidate: Candidate = { provider: 'p', account: null, model: 'm' };
const alternate: Candidate = { provider: 'alt', account: null, model: 'm-alt' };

function request(chain: Candidate[] = [candidate], signal?: AbortSignal): InvocationRequest {
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
    abortSignal: signal,
  };
}

const roots: string[] = [];

async function invoke(service: InvocationService, value: InvocationRequest): Promise<ProviderTurnCompletion> {
  const admission = service.preparePrimaryRequestAdmission(value);
  if (admission.kind !== 'admitted') throw new Error('Unexpected local admission failure in unavailability-wait test.');
  return service.executeAdmittedWithRecovery(admission, value.abortSignal);
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
    const invocation = invoke(service({ availability }), request([candidate], controller.signal));

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
    const invocation = invoke(service({ availability }), request([candidate], controller.signal));

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

  it('discards a late successful availability update after its owner closes', async () => {
    const availability = new MemoryCandidateAvailability();
    const controller = new AbortController();
    let release!: (value: Response) => void;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    jest.spyOn(globalThis, 'fetch').mockImplementation(() => new Promise((resolve) => {
      release = resolve;
      markStarted();
    }));
    const pending = invoke(service({ availability }), request([candidate], controller.signal));
    await started;
    controller.abort(new Error('owner stopped'));
    release(chatSuccess('late'));
    await expect(pending).rejects.toThrow('owner stopped');
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
    const invocation = invoke(service({ availability }), request([candidate], controller.signal));

    controller.abort(reason);

    await expect(invocation).rejects.toBe(reason);
  });
});

function codexOverloadFailure(): LlmRequestError {
  try {
    handleOpenAICodexEvent(JSON.stringify({ type: 'error', error: { code: 'server_is_overloaded', message: 'busy' } }), 200, new Map(), new Set(), [], () => { throw new Error('Unexpected completed message.'); });
  } catch (error) {
    if (error instanceof LlmRequestError) return error;
    throw error;
  }
  throw new Error('Expected exact Codex overload event to fail.');
}

function exchange(source_input_id: string, attempt_index: number, status: 'ok' | 'error'): ProviderExchangeAttempt {
  const common = { contract_id: 'test.v1', contract_name: 'test', transport: 'generic' as const, provider: 'p', model: 'm', source_input_id, attempt_index, request_params: { endpoint: 'https://example.invalid', method: 'POST', stream: false, offered_tools_count: 0, temperature: 0, max_tokens: 10 }, started_at: '2026-08-10T00:00:00.000Z', completed_at: '2026-08-10T00:00:01.000Z', terminal_tool_fired: null };
  return status === 'ok' ? { ...common, status } : { ...common, status, error: { name: 'LlmRequestError', message: 'busy' } };
}
