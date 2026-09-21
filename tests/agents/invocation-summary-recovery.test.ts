import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MemoryCandidateAvailability } from '../../src/agents/candidate-availability.js';
import type { CandidateRequestPlan } from '../../src/agents/candidate-request.js';
import type { CapabilityRequest } from '../../src/agents/provider-capabilities.js';
import { InvocationService, type InvocationRequest } from '../../src/agents/invocation-service.js';
import { ProviderTurnFailure, type LlmCompleteOptions, type ProviderTurnCompletion } from '../../src/agents/llm-contracts.js';
import { LlmRequestError } from '../../src/contracts/llm-failure.js';
import type { ProviderExchangeAttempt } from '../../src/contracts/provider-exchange.js';
import type { Candidate } from '../../src/contracts/provider-candidate.js';
import { NO_FRESHNESS_EFFECTS } from '../../src/application/freshness-effects.js';
import { invocationProviderRegistry } from '../helpers/invocation-provider-fixture.js';

const CANDIDATE: Candidate = { provider: 'summary-provider', account: null, model: 'summary-model' };
const INPUT_ID = '00000000-0000-4000-8000-000000000009';
const roots: string[] = [];

afterEach(() => {
  jest.useRealTimers();
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe('InvocationService internal-summary recovery', () => {
  it('retries one typed flag immediately with the exact retained request and shared input identity', async () => {
    const availability = new MemoryCandidateAvailability();
    const markFailed = jest.spyOn(availability, 'markFailed');
    const service = scriptedService([promptPolicyFailure(), success('summary')], availability);
    const admission = admitted(service);

    await expect(service.executeSummaryWithRecovery(admission)).resolves.toMatchObject({
      result: { kind: 'message', content: 'summary' },
      provider_exchanges: [
        { source_input_id: INPUT_ID, attempt_index: 0, status: 'error' },
        { source_input_id: INPUT_ID, attempt_index: 1, status: 'ok' },
      ],
    });
    expect(service.sentBodies).toHaveLength(2);
    expect(service.sentBodies[1]).toBe(service.sentBodies[0]);
    expect(service.sentRequestHashes[1]).toBe(service.sentRequestHashes[0]);
    expect(service.sentCandidates).toEqual([CANDIDATE, CANDIDATE]);
    expect(service.sentInputIds).toEqual([INPUT_ID, INPUT_ID]);
    expect(markFailed).not.toHaveBeenCalled();
  });

  it('terminates a persistent typed flag after two calls without fallback or availability mutation', async () => {
    const availability = new MemoryCandidateAvailability();
    const markFailed = jest.spyOn(availability, 'markFailed');
    const service = scriptedService([promptPolicyFailure(), promptPolicyFailure()], availability);

    const failure = await service.executeSummaryWithRecovery(admitted(service)).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ProviderTurnFailure);
    expect(failure).toMatchObject({
      provider_exchanges: [
        { source_input_id: INPUT_ID, attempt_index: 0 },
        { source_input_id: INPUT_ID, attempt_index: 1 },
      ],
      originalFailure: { failure: { kind: 'provider_protocol_error', reason: 'prompt_policy_rejection' } },
    });
    expect(service.sentBodies).toHaveLength(2);
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
    private readonly outcomes: Array<ProviderTurnCompletion | ProviderTurnFailure>,
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
    if (outcome instanceof ProviderTurnFailure) throw outcome;
    return outcome;
  }
}

function scriptedService(
  outcomes: Array<ProviderTurnCompletion | ProviderTurnFailure>,
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
