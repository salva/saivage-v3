import { initProjectTree, testCompositionAuthority } from '../helpers/canonical-project.js';
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
import { ReadModelChangeBroadcaster } from '../../src/application/read-model-changes.js';
import { createProviderExchangeMutationPort } from '../../src/persistence/provider-exchange-mutation-port.js';
import type { ProviderExchangeMutationPort } from '../../src/persistence/provider-exchange-mutation-port.js';
import { createTestAuthProfileRepository } from '../helpers/mutation-composition.js';
import { issueCompositionMutationAuthority } from '../../src/application/mutation-authority.js';
import { MemoryCandidateAvailability } from '../../src/agents/candidate-availability.js';

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
    mutationAuthority: issueCompositionMutationAuthority(),
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
  it('accumulates failed attempts before later success and normalizes attempt indexes', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'saivage-invoke-test-'));
    const service = new InvocationService({
      providerExchangeMutations: createProviderExchangeMutationPort(projectRoot, new ReadModelChangeBroadcaster()),
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

    const completion = await service.invokeWithRecovery(request());
    expect(completion.provider_exchanges.map((exchange) => [exchange.provider, exchange.status, exchange.attempt_index])).toEqual([
      ['a', 'error', 0],
      ['b', 'ok', 1],
    ]);
  });

  it('appends multi-row provider results in order and stops at the first persistence error', async () => {
    const appended: string[] = [];
    const persistenceError = new Error('provider exchange persistence failed');
    const abortController = new AbortController();
    const providerExchangeMutations: ProviderExchangeMutationPort = {
      append(data) {
        appended.push(data.payload.provider);
        if (data.payload.provider === 'b') {
          abortController.abort(persistenceError);
          throw persistenceError;
        }
        return {} as never;
      },
    };
    const projectRoot = mkdtempSync(join(tmpdir(), 'saivage-invoke-test-'));
    const service = new InvocationService({
      providerExchangeMutations,
      projectRoot,
      saivageDir: mkdtempSync(join(tmpdir(), 'saivage-invoke-state-')),
      registry: {} as never,
      router: { resolve: async () => candidates, getLastCapabilitySkips: () => [] } as never,
      authProfiles: createTestAuthProfileRepository(projectRoot).repository,
      candidateAvailability: new MemoryCandidateAvailability(),
      llmCallFn: async () => ({
        result: { kind: 'message', content: 'ok' },
        provider_exchanges: [attempt('a', 'error'), attempt('b', 'error'), attempt('c', 'ok')],
      }),
    });

    await expect(service.invokeWithRecovery({ ...request(), abortSignal: abortController.signal })).rejects.toBe(persistenceError);
    expect(appended).toEqual(['a', 'b']);
  });

  it('settles the real InvocationService malformed-attempt rejection through the LLM actor', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'saivage-invoke-actor-test-'));
    const saivageDir = mkdtempSync(join(tmpdir(), 'saivage-invoke-actor-state-'));
    initProjectTree(projectRoot);
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const service = new InvocationService({
        providerExchangeMutations: createProviderExchangeMutationPort(projectRoot, new ReadModelChangeBroadcaster()),
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
      const actor = new LLMActor({ projectRoot, snapshots: testActorSnapshots(projectRoot), conversations: testConversationMutations(projectRoot), mutationAuthority: () => testCompositionAuthority(projectRoot), agentId: 'planner:project', provider: createInvocationServiceProvider(service) });
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
