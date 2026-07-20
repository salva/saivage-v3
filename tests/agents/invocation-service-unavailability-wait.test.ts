import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MemoryCandidateAvailability } from '../../src/agents/candidate-availability.js';
import { InvocationService, type InvocationRequest } from '../../src/agents/invocation-service.js';
import { ProviderTurnFailure, type LlmCallFn } from '../../src/agents/llm-contracts.js';
import type { Candidate } from '../../src/contracts/provider-candidate.js';
import { ReadModelChangeBroadcaster } from '../../src/application/read-model-changes.js';
import { testAppLogs } from '../helpers/app-logs.js';

const candidate: Candidate = { provider: 'p', account: null, model: 'm' };
const alternate: Candidate = { provider: 'alt', account: null, model: 'm-alt' };

function request(chain: Candidate[] = [candidate], signal?: AbortSignal): InvocationRequest {
  return {
    inputId: 'planner:card:1',
    role: 'planner',
    sessionId: 'planner:card',
    systemPrompt: 'system',
    providerConversation: { sourceSessionId: 'planner:card', messages: [] },
    tools: [],
    terminalToolNames: [],
    modelParams: {},
    capabilityRequest: {},
    candidateChain: chain,
    abortSignal: signal,
  };
}

function service(args: { chain?: Candidate[]; availability?: MemoryCandidateAvailability; llmCallFn?: LlmCallFn } = {}): InvocationService {
  const chain = args.chain ?? [candidate];
  const projectRoot = mkdtempSync(join(tmpdir(), 'saivage-invoke-wait-'));
  return new InvocationService({
    appLogs: testAppLogs(projectRoot),
    readModelChanges: new ReadModelChangeBroadcaster(),
    projectRoot,
    saivageDir: mkdtempSync(join(tmpdir(), 'saivage-invoke-wait-state-')),
    registry: {} as never,
    router: { resolve: async () => chain, getLastCapabilitySkips: () => [] } as never,
    candidateAvailability: args.availability ?? new MemoryCandidateAvailability(),
    llmCallFn: args.llmCallFn ?? (async () => ({ result: { kind: 'message', content: 'ok' }, provider_exchanges: [] })),
  });
}

afterEach(() => {
  jest.useRealTimers();
});

describe('InvocationService temporary LLM unavailability wait', () => {
  it('discards a late successful availability update after its owner closes', async () => {
    const availability = new MemoryCandidateAvailability();
    const controller = new AbortController();
    let release!: (value: Awaited<ReturnType<LlmCallFn>>) => void;
    const invocation = service({
      availability,
      llmCallFn: () => new Promise((resolve) => { release = resolve; }),
    });
    const pending = invocation.invokeWithRecovery(request([candidate], controller.signal));
    await Promise.resolve();
    release({ result: { kind: 'message', content: 'late' }, provider_exchanges: [] });
    controller.abort(new Error('owner stopped'));
    await expect(pending).rejects.toThrow('owner stopped');
    expect(availability.getEntry(candidate)).toBeUndefined();
  });

  it('waits and retries after a temporary failed candidate cools down', async () => {
    jest.useFakeTimers({ now: 0 });
    let calls = 0;
    const invocation = service({
      llmCallFn: async () => {
        calls += 1;
        if (calls === 1) throw new Error('transient');
        return { result: { kind: 'message', content: 'ok' }, provider_exchanges: [] };
      },
    }).invokeWithRecovery(request());

    await jest.advanceTimersByTimeAsync(60_000);

    await expect(invocation).resolves.toMatchObject({ result: { kind: 'message', content: 'ok' } });
    expect(calls).toBe(2);
  });

  it('waits when the only candidate is already cooling, then invokes it after the horizon', async () => {
    jest.useFakeTimers({ now: 0 });
    const availability = new MemoryCandidateAvailability();
    availability.markFailed(candidate, { state: 'COOLING', untilMs: 60_000, reason: 'server_transient' });
    let calls = 0;
    const invocation = service({ availability, llmCallFn: async () => {
      calls += 1;
      return { result: { kind: 'message', content: 'ok' }, provider_exchanges: [] };
    } }).invokeWithRecovery(request());

    await jest.advanceTimersByTimeAsync(59_999);
    expect(calls).toBe(0);
    await jest.advanceTimersByTimeAsync(1);

    await expect(invocation).resolves.toMatchObject({ result: { kind: 'message', content: 'ok' } });
    expect(calls).toBe(1);
  });

  it('fails after the fixed two-hour timeout when a temporary candidate never becomes usable', async () => {
    jest.useFakeTimers({ now: 0 });
    const availability = new MemoryCandidateAvailability();
    availability.markFailed(candidate, { state: 'COOLING', untilMs: 3 * 60 * 60 * 1000, reason: 'server_transient' });
    const invocation = service({ availability }).invokeWithRecovery(request());
    const rejection = expect(invocation).rejects.toThrow("No LLM candidate became available for role 'planner' within 7200000ms.");

    await jest.advanceTimersByTimeAsync(2 * 60 * 60 * 1000);

    await rejection;
  });

  it('does not wait when no configured or capability-compatible candidates exist', async () => {
    await expect(service({ chain: [] }).invokeWithRecovery({ ...request([]), candidateChain: [] })).rejects.toBeInstanceOf(ProviderTurnFailure);
  });

  it('does not wait for auth-permanent-only unavailability', async () => {
    jest.useFakeTimers({ now: 0 });
    const availability = new MemoryCandidateAvailability();
    availability.markFailed(candidate, { state: 'BLOCKED_UNTIL', untilMs: 60_000, reason: 'auth_permanent' });

    await expect(service({ availability }).invokeWithRecovery(request())).rejects.toThrow("No healthy candidates available for role 'planner'.");
    expect(jest.getTimerCount()).toBe(0);
  });

  it('tries an available alternate before waiting for a cooled primary', async () => {
    jest.useFakeTimers({ now: 0 });
    const availability = new MemoryCandidateAvailability();
    availability.markFailed(candidate, { state: 'COOLING', untilMs: 60_000, reason: 'server_transient' });
    const seen: Candidate[] = [];

    const completion = await service({
      availability,
      llmCallFn: async (called) => {
        seen.push(called);
        return { result: { kind: 'message', content: called.provider }, provider_exchanges: [] };
      },
    }).invokeWithRecovery(request([candidate, alternate]));

    expect(completion.result).toEqual({ kind: 'message', content: 'alt' });
    expect(seen).toEqual([alternate]);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('propagates aborts during an availability wait without wrapping them', async () => {
    jest.useFakeTimers({ now: 0 });
    const availability = new MemoryCandidateAvailability();
    availability.markFailed(candidate, { state: 'COOLING', untilMs: 60_000, reason: 'server_transient' });
    const controller = new AbortController();
    const reason = new Error('stop');
    const invocation = service({ availability }).invokeWithRecovery(request([candidate], controller.signal));

    controller.abort(reason);

    await expect(invocation).rejects.toBe(reason);
  });
});
