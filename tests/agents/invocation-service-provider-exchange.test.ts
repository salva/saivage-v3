import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from '@jest/globals';

import { InvocationService, type InvocationRequest } from '../../src/agents/invocation-service.js';
import { ProviderTurnFailure } from '../../src/agents/llm-contracts.js';
import type { Candidate } from '../../src/contracts/provider-candidate.js';
import type { ProviderExchangeAttempt } from '../../src/contracts/provider-exchange.js';

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
  it('accumulates failed attempts before later success and normalizes attempt indexes', async () => {
    const service = new InvocationService({
      projectRoot: mkdtempSync(join(tmpdir(), 'saivage-invoke-test-')),
      saivageDir: mkdtempSync(join(tmpdir(), 'saivage-invoke-state-')),
      registry: {} as never,
      router: { resolve: async () => candidates, getLastCapabilitySkips: () => [] } as never,
      llmCallFn: async (candidate) => {
        if (candidate.provider === 'a') throw new ProviderTurnFailure({ failure_phase: 'provider_attempt', provider_exchanges: [attempt('a', 'error')], originalFailure: new Error('temporary') });
        return { result: { kind: 'message', content: 'ok' }, provider_exchanges: [attempt('b', 'ok')] };
      },
    });

    const completion = await service.invokeWithRecovery(request());
    expect(completion.provider_exchanges.map((exchange) => [exchange.provider, exchange.status, exchange.attempt_index])).toEqual([
      ['a', 'error', 0],
      ['b', 'ok', 1],
    ]);
  });
});
