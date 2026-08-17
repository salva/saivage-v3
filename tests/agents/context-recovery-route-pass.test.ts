import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MemoryCandidateAvailability } from '../../src/agents/candidate-availability.js';
import { InvocationService, type InvocationRequest } from '../../src/agents/invocation-service.js';
import {
  AdmittedProviderTurnFailure,
  AdmittedRecoveryIntegrityError,
  capabilityRequestSha256,
  candidateIdentitySha256,
  ordinaryAdmittedExecutionAuthority,
  type SuspendedAdmittedExecution,
} from '../../src/agents/invocation-admission.js';
import { ProviderTurnFailure } from '../../src/agents/llm-contracts.js';
import { prepareCompaction } from '../../src/runtime/actors/compaction/compactor.js';
import { agentMessageSchema } from '../../src/schemas/index.js';
import type { Candidate } from '../../src/contracts/provider-candidate.js';
import { NO_FRESHNESS_EFFECTS } from '../../src/application/freshness-effects.js';
import { chatSuccess, contextExhausted, invocationProviderRegistry, serverUnavailable } from '../helpers/invocation-provider-fixture.js';

const A: Candidate = { provider: 'cand-a', account: null, model: 'model-a' };
const B: Candidate = { provider: 'cand-b', account: null, model: 'model-b' };
const C: Candidate = { provider: 'cand-c', account: null, model: 'model-c' };
const SESSION = 'agent:planner:project';
const roots: string[] = [];

afterEach(() => {
  jest.restoreAllMocks();
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

function message(id: string, content: string) {
  return agentMessageSchema.parse({ id, session_id: SESSION, role: 'user', kind: 'text', content, round_id: `r-pre-${'0'.repeat(32)}`, message_index: 0, block_index: 0, timestamp: '2026-08-16T00:00:00.000Z' });
}

function request(chain: readonly Candidate[], messages = [message('m1', 'x'.repeat(4000)), message('m2', 'y'.repeat(4000))]): InvocationRequest {
  return {
    inputId: '00000000-0000-4000-8000-000000000001',
    agentName: 'planner',
    sessionId: SESSION,
    systemPrompt: 'system',
    providerConversation: { sourceSessionId: SESSION, messages },
    tools: [],
    terminalToolNames: [],
    modelParams: { temperature: 0 },
    preparedCompaction: prepareCompaction({ input_budget_tokens: 100_000, trigger_fraction: 0.8, completion_reserve_fraction: 0.2, merge_line_fraction: 0.3, summary_line_fraction: 0.5, escalate_merge_line_fraction: 0.4, escalate_summary_line_fraction: 0.6, snap: 'compact_straddler' }, 'system', [], 2000),
    capabilityRequest: {},
    routePass: { kind: 'ordinary', candidateChain: [...chain] },
  };
}

function service(candidates: readonly Candidate[], availability = new MemoryCandidateAvailability(), windows: Record<string, number> = {}): InvocationService {
  const projectRoot = mkdtempSync(join(tmpdir(), 'saivage-context-route-pass-'));
  roots.push(projectRoot);
  const overrides = Object.fromEntries(Object.entries(windows).map(([provider, contextWindowTokens]) => [provider, { contextWindowTokens }]));
  return new InvocationService({ projectRoot, freshness: NO_FRESHNESS_EFFECTS, registry: invocationProviderRegistry(candidates, overrides), candidateAvailability: availability });
}

function admitted(service: InvocationService, value: InvocationRequest) {
  const admission = service.preparePrimaryRequestAdmission(value);
  if (admission.kind !== 'admitted') throw new Error(`Expected admitted route pass, got ${admission.kind}.`);
  return admission;
}

function compacted(value: InvocationRequest): InvocationRequest {
  return withMessages(value, ['compact summary']);
}

function withMessages(value: InvocationRequest, contents: readonly string[]): InvocationRequest {
  return { ...value, providerConversation: { sourceSessionId: SESSION, messages: contents.map((content, index) => message(`m${index + 1}`, content)) } };
}

describe('ordinary admitted execution immutable-membership recovery', () => {
  it('marks only the attempted member context_failed and keeps earlier rate-limited and later untried members viable', async () => {
    const availability = new MemoryCandidateAvailability();
    availability.markFailed(A, { state: 'BLOCKED_UNTIL', untilMs: Date.now() + 3_600_000, reason: 'rate_limit' });
    const calls: string[] = [];
    let bCalls = 0;
    jest.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const provider = new URL(String(input)).hostname.split('.')[0]!;
      calls.push(provider);
      if (provider === 'cand-b') {
        bCalls += 1;
        return bCalls === 1 ? contextExhausted() : chatSuccess('b-recovered');
      }
      return chatSuccess('unexpected');
    });
    const value = request([A, B, C]);
    const svc = service([A, B, C], availability);
    let suspension: SuspendedAdmittedExecution;
    try {
      await svc.executeAdmittedWithRecovery(admitted(svc, value));
      throw new Error('Expected context failure suspension.');
    } catch (error) {
      if (!(error instanceof AdmittedProviderTurnFailure)) throw error;
      suspension = error.suspension;
    }
    expect(calls).toEqual(['cand-b']);
    expect(suspension!.contextFailedIdentity).toEqual(B);
    expect(suspension!.authority).toEqual(ordinaryAdmittedExecutionAuthority([A, B, C]));
    expect(suspension!.records.map((record) => [record.identity.provider, record.state.kind])).toEqual([
      ['cand-a', 'untried'],
      ['cand-b', 'context_failed'],
      ['cand-c', 'untried'],
    ]);
    expect(suspension!.settledProviderAttempts).toHaveLength(1);
    expect(suspension!.settledProviderAttempts[0]).toMatchObject({ source_input_id: value.inputId, attempt_index: 0, status: 'error' });
    expect((suspension!.records[1]!.state as { failure: ProviderTurnFailure }).failure.failure_phase).toBe('provider_attempt');

    const preparation = svc.prepareAdmittedRecovery({ suspension: suspension!, request: compacted(value) });
    expect(preparation.mandatoryFirstIdentity).toEqual(B);
    expect(preparation.plans.map((plan) => plan.routeIndex)).toEqual([0, 1, 2]);
    const completion = await svc.resumeAdmittedExecution(preparation);
    expect(completion.result).toMatchObject({ kind: 'message', content: 'b-recovered' });
    expect(calls).toEqual(['cand-b', 'cand-b']);
    expect(completion.provider_exchanges.map((attempt) => [attempt.attempt_index, attempt.status])).toEqual([[0, 'error'], [1, 'ok']]);
  });

  it('keeps the mandatory member first, then resumes ordinary scheduling over still-viable retained members', async () => {
    jest.useFakeTimers({ now: 0 });
    const availability = new MemoryCandidateAvailability();
    availability.markFailed(A, { state: 'BLOCKED_UNTIL', untilMs: Date.now() + 3_600_000, reason: 'rate_limit' });
    const calls: string[] = [];
    let bCalls = 0;
    jest.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const provider = new URL(String(input)).hostname.split('.')[0]!;
      calls.push(provider);
      if (provider === 'cand-b') {
        bCalls += 1;
        return bCalls === 1 ? contextExhausted() : serverUnavailable('compact retry unavailable');
      }
      if (provider === 'cand-c') return chatSuccess('c-wins');
      throw new Error(`Unexpected provider ${provider}.`);
    });
    const value = request([A, B, C]);
    const svc = service([A, B, C], availability);
    const handoff = await svc.executeAdmittedWithRecovery(admitted(svc, value)).then(
      () => { throw new Error('Expected suspension.'); },
      (error: unknown) => {
        if (!(error instanceof AdmittedProviderTurnFailure)) throw error;
        return error.suspension;
      },
    );
    const preparation = svc.prepareAdmittedRecovery({ suspension: handoff, request: compacted(value) });
    const pending = svc.resumeAdmittedExecution(preparation);
    await jest.advanceTimersByTimeAsync(200_000);
    const completion = await pending;
    expect(calls).toEqual(['cand-b', 'cand-b', 'cand-b', 'cand-b', 'cand-c']);
    expect(completion.result).toMatchObject({ kind: 'message', content: 'c-wins' });
    expect(completion.provider_exchanges.map((attempt) => attempt.attempt_index)).toEqual([0, 1, 2, 3, 4]);
  });

  it('excludes an exhausted member from compacted recovery while the context-failed member still retries first', async () => {
    jest.useFakeTimers({ now: 0 });
    const calls: string[] = [];
    let aCalls = 0;
    let bCalls = 0;
    jest.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const provider = new URL(String(input)).hostname.split('.')[0]!;
      calls.push(provider);
      if (provider === 'cand-a') {
        aCalls += 1;
        return serverUnavailable(`a-failure-${aCalls}`);
      }
      bCalls += 1;
      return bCalls === 1 ? contextExhausted() : chatSuccess('b-recovered');
    });
    const value = request([A, B]);
    const svc = service([A, B]);
    const handoffPromise = svc.executeAdmittedWithRecovery(admitted(svc, value)).then(
      () => { throw new Error('Expected suspension.'); },
      (error: unknown) => {
        if (!(error instanceof AdmittedProviderTurnFailure)) throw error;
        return error.suspension;
      },
    );
    await jest.advanceTimersByTimeAsync(4 * 60_000);
    const handoff = await handoffPromise;
    expect(handoff.records.map((record) => [record.identity.provider, record.state.kind])).toEqual([['cand-a', 'exhausted'], ['cand-b', 'context_failed']]);
    const preparation = svc.prepareAdmittedRecovery({ suspension: handoff, request: compacted(value) });
    expect(preparation.plans.map((entry) => entry.routeIndex)).toEqual([1]);
    const pendingResume = svc.resumeAdmittedExecution(preparation);
    await jest.advanceTimersByTimeAsync(60_000);
    const completion = await pendingResume;
    expect(completion.result).toMatchObject({ kind: 'message', content: 'b-recovered' });
    expect(calls.filter((provider) => provider === 'cand-a')).toHaveLength(4);
    expect(calls.filter((provider) => provider === 'cand-b')).toHaveLength(2);
  });

  it('terminates with the settled real attempts when the mandatory member does not re-admit', async () => {
    const availability = new MemoryCandidateAvailability();
    availability.markFailed(A, { state: 'BLOCKED_UNTIL', untilMs: Date.now() + 3_600_000, reason: 'rate_limit' });
    jest.spyOn(globalThis, 'fetch').mockImplementation(async (input) =>
      new URL(String(input)).hostname.startsWith('cand-b') ? contextExhausted() : chatSuccess('unexpected'));
    const value = request([B], [message('m1', 'x'.repeat(1000)), message('m2', 'y'.repeat(1000))]);
    const svc = service([B], new MemoryCandidateAvailability(), { 'cand-b': 3000 });
    const handoff = await svc.executeAdmittedWithRecovery(admitted(svc, value)).then(
      () => { throw new Error('Expected suspension.'); },
      (error: unknown) => {
        if (!(error instanceof AdmittedProviderTurnFailure)) throw error;
        return error.suspension;
      },
    );
    const still = withMessages(value, ['z'.repeat(9000), 'z'.repeat(9000)]);
    expect(() => svc.prepareAdmittedRecovery({ suspension: handoff, request: still })).toThrow(ProviderTurnFailure);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['reordered records', (suspension: SuspendedAdmittedExecution) => ({ ...suspension, records: [...suspension.records].reverse() })],
    ['extra record', (suspension: SuspendedAdmittedExecution) => ({ ...suspension, records: [...suspension.records, suspension.records[0]!] })],
    ['missing record', (suspension: SuspendedAdmittedExecution) => ({ ...suspension, records: suspension.records.slice(0, -1) })],
    ['duplicated context failure', (suspension: SuspendedAdmittedExecution) => ({ ...suspension, records: suspension.records.map((record) => record.state.kind === 'untried' && suspension.records[1]!.state.kind === 'context_failed' ? { ...record, state: suspension.records[1]!.state } : record) })],
    ['corrupt settled attempt index', (suspension: SuspendedAdmittedExecution) => ({ ...suspension, settledProviderAttempts: suspension.settledProviderAttempts.map((attempt, index) => ({ ...attempt, attempt_index: index + 5 })) })],
    ['mutated authority membership', (suspension: SuspendedAdmittedExecution) => ({ ...suspension, authority: ordinaryAdmittedExecutionAuthority([C, B]) })],
  ])('fails recovery preparation before retry transport for %s', async (_name, corrupt) => {
    const availability = new MemoryCandidateAvailability();
    availability.markFailed(A, { state: 'BLOCKED_UNTIL', untilMs: Date.now() + 3_600_000, reason: 'rate_limit' });
    jest.spyOn(globalThis, 'fetch').mockImplementation(async (input) =>
      new URL(String(input)).hostname.startsWith('cand-b') ? contextExhausted() : chatSuccess('unexpected'));
    const value = request([A, B, C]);
    const svc = service([A, B, C], availability);
    const handoff = await svc.executeAdmittedWithRecovery(admitted(svc, value)).then(
      () => { throw new Error('Expected suspension.'); },
      (error: unknown) => {
        if (!(error instanceof AdmittedProviderTurnFailure)) throw error;
        return error.suspension;
      },
    );
    expect(() => svc.prepareAdmittedRecovery({ suspension: corrupt(handoff), request: compacted(value) })).toThrow(AdmittedRecoveryIntegrityError);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  it('fails recovery preparation for changed bindings across compaction', async () => {
    const availability = new MemoryCandidateAvailability();
    availability.markFailed(A, { state: 'BLOCKED_UNTIL', untilMs: Date.now() + 3_600_000, reason: 'rate_limit' });
    jest.spyOn(globalThis, 'fetch').mockImplementation(async (input) =>
      new URL(String(input)).hostname.startsWith('cand-b') ? contextExhausted() : chatSuccess('unexpected'));
    const value = request([A, B]);
    const svc = service([A, B], availability);
    const handoff = await svc.executeAdmittedWithRecovery(admitted(svc, value)).then(
      () => { throw new Error('Expected suspension.'); },
      (error: unknown) => {
        if (!(error instanceof AdmittedProviderTurnFailure)) throw error;
        return error.suspension;
      },
    );
    expect(() => svc.prepareAdmittedRecovery({ suspension: handoff, request: { ...compacted(value), systemPrompt: 'different prompt' } })).toThrow(AdmittedRecoveryIntegrityError);
    expect(() => svc.prepareAdmittedRecovery({ suspension: handoff, request: { ...compacted(value), inputId: '00000000-0000-4000-8000-000000000099' } })).toThrow(AdmittedRecoveryIntegrityError);
    expect(() => svc.prepareAdmittedRecovery({ suspension: handoff, request: { ...compacted(value), capabilityRequest: { requiresTools: true } } })).toThrow(AdmittedRecoveryIntegrityError);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  it('carries the immutable capability request and identity hashes on every verdict', () => {
    const svc = service([A, B]);
    const admission = svc.preparePrimaryRequestAdmission(request([A, B]));
    expect(admission.kind).toBe('admitted');
    if (admission.kind !== 'admitted') throw new Error('unreachable');
    const hash = capabilityRequestSha256(admission.candidates[0]!.capabilityRequest);
    for (const verdict of admission.candidates) {
      expect(verdict.capabilityRequest).toEqual({});
      expect(verdict.capabilityRequestSha256).toBe(hash);
      expect(candidateIdentitySha256(verdict.candidate)).toHaveLength(64);
    }
  });

  it('terminates without failover at the first authoritative context rejection inside one execution pass', async () => {
    const calls: string[] = [];
    jest.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      calls.push(new URL(String(input)).hostname.split('.')[0]!);
      return contextExhausted();
    });
    const value = request([A, B]);
    const svc = service([A, B]);
    await expect(svc.executeAdmittedWithRecovery(admitted(svc, value))).rejects.toBeInstanceOf(AdmittedProviderTurnFailure);
    expect(calls).toEqual(['cand-a']);
    expect(calls).toHaveLength(1);
  });
});
