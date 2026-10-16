import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MemoryCandidateAvailability } from '../../src/agents/candidate-availability.js';
import type { CandidateRequestPlan } from '../../src/contracts/index.js';
import type { CapabilityRequest } from '../../src/contracts/index.js';
import { InvocationService, type InvocationRequest } from '../../src/agents/invocation-service.js';
import { type LlmCompleteOptions } from '../../src/contracts/index.js';
import { ProviderTurnFailure, type ProviderTurnCompletion } from '../../src/contracts/index.js';
import { LlmRequestError } from '../../src/contracts/llm-failure.js';
import type { ProviderExchangeAttempt } from '../../src/contracts/provider-exchange.js';
import type { Candidate } from '../../src/contracts/provider-candidate.js';
import { NO_FRESHNESS_EFFECTS } from '../../src/contracts/index.js';
import { invocationProviderRegistry } from '../helpers/invocation-provider-fixture.js';

const CANDIDATE: Candidate = { provider: 'summary-provider', account: null, model: 'summary-model' };
const INPUT_ID = '00000000-0000-4000-8000-000000000009';
const roots: string[] = [];

afterEach(() => {
  jest.useRealTimers();
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe('InvocationService internal-summary recovery', () => {
  it.each(['wait', 'loop'] as const)('retains prior evidence when exact cancellation exits the retry %s', async site => {
    jest.useFakeTimers({ now: 0 });
    const controller = new AbortController();
    const reason = new Error('urgent cancellation');
    const availability = new MemoryCandidateAvailability();
    const first = site === 'loop' ? providerFailure(new LlmRequestError({ kind: 'server_overloaded', provider: CANDIDATE.provider, status: 503, message: 'busy' })) : parseFailure();
    const service = scriptedService([first, success('never')], availability);
    const pending = service.executeSummaryWithRecovery(admitted(service), controller.signal).catch(error => error);
    if (site === 'loop') {
      const failed = jest.spyOn(availability, 'markFailed');
      failed.mockImplementation(() => controller.abort(reason));
    }
    await jest.advanceTimersByTimeAsync(0);
    if (site === 'wait') {
      expect(jest.getTimerCount()).toBe(1);
      controller.abort(reason);
    }
    const failure = await pending;
    expect(failure).toBeInstanceOf(ProviderTurnFailure);
    expect(failure.originalFailure).toBe(reason);
    expect(failure.candidate).toBeNull();
    expect(failure.provider_exchanges).toMatchObject([{ attempt_index: 0, source_input_id: INPUT_ID }]);
    expect(service.sentBodies).toHaveLength(1);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('leaves evidence-free before-send cancellation raw', async () => {
    const controller = new AbortController();
    const reason = new Error('before send');
    controller.abort(reason);
    const service = scriptedService([]);
    await expect(service.executeSummaryWithRecovery(admitted(service), controller.signal)).rejects.toBe(reason);
    expect(service.sentBodies).toHaveLength(0);
  });

  it.each([
    ['summary', 'parse_error'], ['summary', 'provider_protocol_error'], ['summary', 'cancelled'], ['primary', 'parse_error'],
  ] as const)('keeps a distinct %s %s failure racing cancellation terminal', async (purpose, kind) => {
    const controller = new AbortController();
    const reason = new Error('same message');
    const actual = kind === 'cancelled'
      ? new LlmRequestError({ kind, provider: CANDIDATE.provider, message: reason.message, reason: 'abort' })
      : kind === 'provider_protocol_error'
        ? new LlmRequestError({ kind, provider: CANDIDATE.provider, status: 200, message: reason.message })
        : new LlmRequestError({ kind, provider: CANDIDATE.provider, message: reason.message });
    const availability = new MemoryCandidateAvailability();
    const failed = jest.spyOn(availability, 'markFailed');
    const service = scriptedService([() => { controller.abort(reason); throw providerFailure(actual); }], availability);
    const admission = admitted(service);
    const pending = purpose === 'summary' ? service.executeSummaryWithRecovery(admission, controller.signal) : service.executeAdmittedWithRecovery(admission, controller.signal);
    const failure = await pending.catch(error => error);
    expect(failure.originalFailure).toBe(actual);
    expect(failure.provider_exchanges).toMatchObject([{ attempt_index: 0, source_input_id: INPUT_ID }]);
    expect(service.sentBodies).toHaveLength(1);
    expect(failed).not.toHaveBeenCalled();
  });
  it.each(['success', 'refusal', 'auth', 'protocol'] as const)('retains one summary admission/input through more than 64 overload transports, then %s', async outcome => {
    jest.useFakeTimers({ now: 0 });
    const overload = () => providerFailure(new LlmRequestError({ kind: 'server_overloaded', provider: CANDIDATE.provider, status: 200, message: 'busy' }));
    const final = outcome === 'success' ? success('summary recovered') : outcome === 'refusal' ? promptPolicyFailure()
      : providerFailure(new LlmRequestError({ kind: outcome === 'auth' ? 'auth_permanent' : 'provider_protocol_error', provider: CANDIDATE.provider, status: 200, message: 'terminal' }));
    const service = scriptedService([...Array.from({ length: 65 }, overload), final]);
    const pending = service.executeSummaryWithRecovery(admitted(service)).catch(error => error);
    await jest.advanceTimersByTimeAsync(930_000 + 60 * 600_000);
    const settled = await pending;
    expect(settled.provider_exchanges).toHaveLength(66);
    expect(settled.provider_exchanges.map((attempt: ProviderExchangeAttempt) => attempt.attempt_index)).toEqual(Array.from({ length: 66 }, (_, index) => index));
    expect(new Set(service.sentBodies).size).toBe(1);
    expect(new Set(service.sentRequestHashes).size).toBe(1);
    expect(new Set(service.sentInputIds)).toEqual(new Set([INPUT_ID]));
    expect(service.sentCandidates).toEqual(Array<Candidate>(66).fill(CANDIDATE));
    if (outcome === 'success') expect(settled).toMatchObject({ result: { kind: 'message', content: 'summary recovered' } });
    else expect(settled).toMatchObject({ originalFailure: (final as ProviderTurnFailure).originalFailure });
    expect(jest.getTimerCount()).toBe(0);
  });

  it.each(['prompt_flag', 'cyber_policy'] as const)('terminates first %s with actual classifier evidence and no second request', async (kind) => {
    const availability = new MemoryCandidateAvailability();
    const markFailed = jest.spyOn(availability, 'markFailed');
    const original = kind === 'prompt_flag' ? promptPolicyFailure() : providerFailure(new LlmRequestError({ kind: 'content_policy', provider: CANDIDATE.provider, status: 200, message: 'cyber_policy', providerResponse: '' }));
    const service = scriptedService([original, success('summary')], availability);
    const admission = admitted(service);

    await expect(service.executeSummaryWithRecovery(admission)).rejects.toMatchObject({
      originalFailure: original.originalFailure,
      provider_exchanges: [
        { source_input_id: INPUT_ID, attempt_index: 0, status: 'error' },
      ],
    });
    expect(service.sentBodies).toHaveLength(1);
    expect(service.sentRequestHashes).toEqual(service.sentBodies.map((bytes) => createHash('sha256').update(bytes, 'utf8').digest('hex')));
    expect(service.sentCandidates).toEqual([CANDIDATE]);
    expect(service.sentInputIds).toEqual([INPUT_ID]);
    expect(markFailed).not.toHaveBeenCalled();
  });

  it('terminates a persistent typed flag after one call without fallback or availability mutation', async () => {
    const availability = new MemoryCandidateAvailability();
    const markFailed = jest.spyOn(availability, 'markFailed');
    const service = scriptedService([promptPolicyFailure(), promptPolicyFailure()], availability);

    const failure = await service.executeSummaryWithRecovery(admitted(service)).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ProviderTurnFailure);
    expect(failure).toMatchObject({
      provider_exchanges: [
        { source_input_id: INPUT_ID, attempt_index: 0 },
      ],
      originalFailure: { failure: { kind: 'provider_protocol_error', reason: 'prompt_policy_rejection' } },
    });
    expect(service.sentBodies).toHaveLength(1);
    expect(markFailed).not.toHaveBeenCalled();
  });

  it('keeps the same typed flag terminal for primary execution', async () => {
    const service = scriptedService([promptPolicyFailure()]);
    const failure = await service.executeAdmittedWithRecovery(admitted(service)).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ProviderTurnFailure);
    expect((failure as ProviderTurnFailure).provider_exchanges).toHaveLength(1);
    expect(service.sentBodies).toHaveLength(1);
  });

  it('does not exceed four calls when a typed flag arrives after three ordinary retryable failures', async () => {
    jest.useFakeTimers({ now: 0 });
    const service = scriptedService([parseFailure(), parseFailure(), parseFailure(), promptPolicyFailure()]);
    const pending = service.executeSummaryWithRecovery(admitted(service)).catch((error: unknown) => error);
    await jest.advanceTimersByTimeAsync(3 * 60_000);
    const failure = await pending;
    expect(failure).toBeInstanceOf(ProviderTurnFailure);
    expect((failure as ProviderTurnFailure).provider_exchanges.map((attempt) => attempt.attempt_index)).toEqual([0, 1, 2, 3]);
    expect(service.sentBodies).toHaveLength(4);
  });
});

class ScriptedInvocationService extends InvocationService {
  readonly sentBodies: string[] = [];
  readonly sentRequestHashes: string[] = [];
  readonly sentCandidates: Candidate[] = [];
  readonly sentInputIds: string[] = [];

  constructor(
    projectRoot: string,
    availability: MemoryCandidateAvailability,
    private readonly outcomes: Array<ProviderTurnCompletion | ProviderTurnFailure | (() => never)>,
  ) {
    super({ projectRoot, registry: invocationProviderRegistry([CANDIDATE]), candidateAvailability: availability, freshness: NO_FRESHNESS_EFFECTS });
  }

  protected override async executeAdmittedPlan(
    plan: CandidateRequestPlan,
    options: LlmCompleteOptions,
    _capabilityRequest: Readonly<CapabilityRequest>,
  ): Promise<ProviderTurnCompletion> {
    this.sentBodies.push(plan.request.serializedBody);
    this.sentRequestHashes.push(plan.request.requestHash);
    this.sentCandidates.push(plan.candidate);
    this.sentInputIds.push(options.inputId);
    const outcome = this.outcomes.shift();
    if (!outcome) throw new Error('Missing scripted summary outcome.');
    if (typeof outcome === 'function') return outcome();
    if (outcome instanceof ProviderTurnFailure) throw outcome;
    return outcome;
  }
}

function scriptedService(
  outcomes: Array<ProviderTurnCompletion | ProviderTurnFailure | (() => never)>,
  availability = new MemoryCandidateAvailability(),
): ScriptedInvocationService {
  const root = mkdtempSync(join(tmpdir(), 'saivage-summary-recovery-'));
  roots.push(root);
  return new ScriptedInvocationService(root, availability, outcomes);
}

function admitted(service: InvocationService) {
  const result = service.preparePrimaryRequestAdmission(request());
  if (result.kind !== 'admitted') throw new Error(`Expected admitted summary request, got ${result.kind}.`);
  return result;
}

function request(): InvocationRequest {
  return {
    inputId: INPUT_ID,
    agentName: 'internal-compaction-summary',
    sessionId: 'internal:compaction-summary:0123',
    systemPrompt: 'summarize',
    providerConversation: { sourceSessionId: 'agent:planner:project', messages: [] },
    tools: [],
    terminalToolNames: [],
    capabilityRequest: { requiresTools: false },
    modelParams: { temperature: 0, maxTokens: 2_000 },
    routePass: { kind: 'ordinary', candidateChain: [CANDIDATE] },
  };
}

function promptPolicyFailure(): ProviderTurnFailure {
  return providerFailure(new LlmRequestError({
    kind: 'provider_protocol_error',
    provider: CANDIDATE.provider,
    status: 200,
    message: 'raw provider policy flag',
    reason: 'prompt_policy_rejection',
  }));
}

function parseFailure(): ProviderTurnFailure {
  return providerFailure(new LlmRequestError({ kind: 'parse_error', provider: CANDIDATE.provider, message: 'truncated stream' }));
}

function providerFailure(originalFailure: LlmRequestError): ProviderTurnFailure {
  return new ProviderTurnFailure({
    failure_phase: 'provider_attempt',
    provider_exchanges: [attempt('error')],
    originalFailure,
    candidate: CANDIDATE,
  });
}

function success(content: string): ProviderTurnCompletion {
  return { result: { kind: 'message', content }, provider_exchanges: [attempt('ok')] };
}

function attempt(status: 'ok' | 'error'): ProviderExchangeAttempt {
  const common = {
    contract_id: 'summary.v1', contract_name: 'summary', transport: 'generic' as const, provider: CANDIDATE.provider, model: CANDIDATE.model,
    source_input_id: 'provider-local', attempt_index: 99,
    request_params: { endpoint: 'https://example.invalid', method: 'POST', stream: true, offered_tools_count: 0, temperature: 0, max_tokens: 2_000 },
    started_at: '2026-09-21T00:00:00.000Z', completed_at: '2026-09-21T00:00:01.000Z',
    terminal_tool_fired: null,
  };
  return status === 'ok'
    ? { ...common, status, finish_reason: 'stop' }
    : { ...common, status, error: { name: 'LlmRequestError', message: 'failed' } };
}
