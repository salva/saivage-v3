import { initProjectTree } from '../helpers/canonical-project.js';
import { testActorSnapshots } from '../helpers/actor-snapshots.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { testConversationMutations } from '../helpers/conversation-mutations.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, jest } from '@jest/globals';

import { InvocationService, type InvocationRequest } from '../../src/agents/invocation-service.js';
import { ProviderTurnFailure } from '../../src/agents/llm-contracts.js';
import { LlmRequestError } from '../../src/contracts/llm-failure.js';
import type { Candidate } from '../../src/contracts/provider-candidate.js';
import type { ProviderExchangeAttempt } from '../../src/contracts/provider-exchange.js';
import { createInvocationServiceProvider } from '../../src/application/micro-actor-runtime-api-factory.js';

import { LLMActor } from '../../src/runtime/actors/llm-actor.js';
import { readActorSnapshots } from '../../src/runtime/actors/snapshots.js';
import { testAppLogs } from '../helpers/app-logs.js';
import { createTestAuthProfileRepository } from '../helpers/mutation-composition.js';
import { MemoryCandidateAvailability } from '../../src/agents/candidate-availability.js';
import { ApplicationPersistenceHealth } from '../../src/application/persistence-health.js';
import { readProviderExchangeLogEntries } from '../../src/persistence/provider-exchange-log.js';

const candidates: Candidate[] = [
  { provider: 'a', account: null, model: 'm-a' },
  { provider: 'b', account: null, model: 'm-b' },
];

function attempt(provider: string, status: 'ok' | 'error'): ProviderExchangeAttempt {
  const base = {
    contract_id: 'planner.v1',
    contract_name: 'planner',
    transport: 'generic' as const,
    provider,
    model: `m-${provider}`,
    source_input_id: 'planner:card:1',
    request_params: {},
    started_at: '2026-01-01T00:00:00.000Z',
    completed_at: '2026-01-01T00:00:01.000Z',
    terminal_tool_fired: null,
  };
  return status === 'ok'
    ? { ...base, status: 'ok', response_status: 200 }
    : { ...base, status: 'error', error: { name: 'Error', message: 'temporary' } };
}

function request(): InvocationRequest {
  return {
    inputId: 'planner:card:1',
    role: 'planner',
    sessionId: 'planner:card',
    systemPrompt: 'system',
    contextMessages: [],
    tools: [],
    terminalToolNames: [],
    modelParams: {},
    capabilityRequest: {},
    candidateChain: candidates,
  };
}

describe('InvocationService provider exchange accumulation', () => {
  it('rejects a provider completion that arrives after persistence became unhealthy', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'saivage-invoke-health-'));
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => { release = resolve; });
    const health = new ApplicationPersistenceHealth();
    const service = new InvocationService({
      appLogs: testAppLogs(projectRoot), projectRoot, saivageDir: projectRoot, registry: {} as never,
      router: { resolve: async () => candidates, getLastCapabilitySkips: () => [] } as never,
      authProfiles: createTestAuthProfileRepository(projectRoot).repository,
      candidateAvailability: new MemoryCandidateAvailability(), persistenceHealth: health,
      llmCallFn: async () => { await waiting; return { result: { kind: 'message', content: 'late' }, provider_exchanges: [attempt('a', 'ok')] }; },
    });
    const result = service.invokeCall(request(), candidates[0]!);
    expect(() => health.reportUncertainFailure({ target: 'test', operation: 'append', error: new Error('uncertain') })).toThrow();
    release();
    await expect(result).rejects.toThrow('mutation-unhealthy');
  });

  it('accumulates failed attempts before later success and normalizes attempt indexes', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'saivage-invoke-test-'));
    const service = new InvocationService({
      appLogs: testAppLogs(projectRoot),
      projectRoot,
      saivageDir: mkdtempSync(join(tmpdir(), 'saivage-invoke-state-')),
      registry: {} as never,
      router: { resolve: async () => candidates, getLastCapabilitySkips: () => [] } as never,
      authProfiles: createTestAuthProfileRepository(projectRoot).repository,
      candidateAvailability: new MemoryCandidateAvailability(),
      llmCallFn: async (candidate) => {
        if (candidate.provider === 'a') throw new ProviderTurnFailure({ failure_phase: 'provider_attempt', provider_exchanges: [attempt('a', 'error')], originalFailure: new LlmRequestError({ kind: 'rate_limit', provider: 'a', status: 429, message: 'temporary', retryAfterMs: 60_000 }) });
        return { result: { kind: 'message', content: 'ok' }, provider_exchanges: [attempt('b', 'ok')] };
      },
    });

    const invocation = request();
    const completion = await service.invokeWithRecovery(invocation);
    expect(completion.provider_exchanges.map((exchange) => [exchange.provider, exchange.status, exchange.attempt_index])).toEqual([
      ['a', 'error', 0],
      ['b', 'ok', 1],
    ]);
    expect(readProviderExchangeLogEntries(projectRoot, invocation.sessionId)).toEqual([]);
    service.projectProviderExchanges(invocation.sessionId, invocation.inputId, completion.provider_exchanges, [`${invocation.inputId}:message`]);
    expect(readProviderExchangeLogEntries(projectRoot, invocation.sessionId).map((exchange) => [exchange.payload.provider, exchange.payload.status === 'ok' ? exchange.payload.assistant_output_ids : null])).toEqual([
      ['a', null],
      ['b', [`${invocation.inputId}:message`]],
    ]);
  });

  it('settles the real InvocationService malformed-attempt rejection through the LLM actor', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'saivage-invoke-actor-test-'));
    const saivageDir = mkdtempSync(join(tmpdir(), 'saivage-invoke-actor-state-'));
    initProjectTree(projectRoot);
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const service = new InvocationService({
        appLogs: testAppLogs(projectRoot),
        projectRoot,
        saivageDir,
        registry: {} as never,
        router: { resolve: async () => [candidates[0]!], getLastCapabilitySkips: () => [] } as never,
        authProfiles: createTestAuthProfileRepository(projectRoot).repository,
        candidateAvailability: new MemoryCandidateAvailability(),
        llmCallFn: async () => {
          throw new ProviderTurnFailure({ failure_phase: 'provider_attempt', provider_exchanges: [], originalFailure: new Error('missing envelope') });
        },
      });
      const actor = new LLMActor({ projectRoot, snapshots: testActorSnapshots(projectRoot), conversations: testConversationMutations(projectRoot), agentId: 'planner:project', provider: createInvocationServiceProvider(service) });
      actor.start();

      await expect(actor.turn({
        inputId: 'planner:project:1', agentId: 'planner:project', role: 'planner', sessionId: 'planner:project', systemPrompt: 'system', contextMessages: [], tools: [], terminalToolNames: [], modelParams: {}, capabilityRequest: {}, episodeContext: { cardId: 'project' },
      })).rejects.toThrow("Provider boundary for 'planner:project:1' failed without ProviderTurnFailure metadata.");

      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(actor.state()).toBe('idle');
      expect(readActorSnapshots(projectRoot).find((snapshot) => snapshot.actor_id === 'planner:project')?.context.active_reconstruction).toBeNull();
    } finally {
      consoleError.mockRestore();
      rmSync(projectRoot, { recursive: true, force: true });
      rmSync(saivageDir, { recursive: true, force: true });
    }
  });
});
