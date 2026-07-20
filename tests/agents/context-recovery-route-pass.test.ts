import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MemoryCandidateAvailability } from '../../src/agents/candidate-availability.js';
import { InvocationService, type InvocationRequest } from '../../src/agents/invocation-service.js';
import { ProviderTurnFailure, type LlmCallFn } from '../../src/agents/llm-contracts.js';
import { LlmRequestError } from '../../src/contracts/llm-failure.js';
import type { Candidate } from '../../src/contracts/provider-candidate.js';
import type { ProviderExchangeAttempt } from '../../src/contracts/provider-exchange.js';
import { testAppLogs } from '../helpers/app-logs.js';
import { ReadModelChangeBroadcaster } from '../../src/application/read-model-changes.js';

const roots: string[] = [];
afterEach(() => { while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true }); });

describe('authoritative context route-pass ordering', () => {
  it('ends each ordinary route pass at the first context rejection without candidate failover', async () => {
    const first: Candidate = { provider: 'test-a', account: null, model: 'model-a' };
    const second: Candidate = { provider: 'test-b', account: null, model: 'model-b' };
    const calls: string[] = [];
    const llmCallFn: LlmCallFn = jest.fn<LlmCallFn>(async (candidate, _prompt, _conversation, _session, options) => {
      calls.push(candidate.provider);
      const originalFailure = new LlmRequestError({ kind: 'input_context_exhausted', provider: candidate.provider, status: 400, message: 'structured context rejection' });
      throw new ProviderTurnFailure({ failure_phase: 'provider_attempt', provider_exchanges: [errorAttempt(options.inputId, candidate)], originalFailure });
    });
    const service = invocationService(llmCallFn);
    const request: InvocationRequest = { inputId: '00000000-0000-4000-8000-000000000001', role: 'planner', sessionId: 'planner:project', systemPrompt: 'system', providerConversation: { sourceSessionId: 'planner:project', messages: [] }, tools: [], terminalToolNames: [], modelParams: { maxTokens: 100 }, capabilityRequest: {}, candidateChain: [first, second] };

    await expect(service.invokeWithRecovery(request)).rejects.toMatchObject({ failure: { kind: 'input_context_exhausted' }, provider_exchanges: [{ attempt_index: 0 }] });
    expect(calls).toEqual(['test-a']);

    await expect(service.invokeWithRecovery({ ...request, providerConversation: { sourceSessionId: 'planner:project', messages: [] } })).rejects.toMatchObject({ failure: { kind: 'input_context_exhausted' }, provider_exchanges: [{ attempt_index: 0 }] });
    expect(calls).toEqual(['test-a', 'test-a']);
  });
});

function invocationService(llmCallFn: LlmCallFn): InvocationService {
  const root = mkdtempSync(join(tmpdir(), 'saivage-context-route-pass-'));
  roots.push(root);
  return new InvocationService({ projectRoot: root, saivageDir: root, appLogs: testAppLogs(root), readModelChanges: new ReadModelChangeBroadcaster(), registry: {} as never, router: { getLastCapabilitySkips: () => [] } as never, candidateAvailability: new MemoryCandidateAvailability(), llmCallFn });
}

function errorAttempt(inputId: string, candidate: Candidate): ProviderExchangeAttempt {
  return { contract_id: 'test.v1', contract_name: 'test', transport: 'generic', provider: candidate.provider, model: candidate.model, source_input_id: inputId, request_params: {}, started_at: '2026-07-17T00:00:00.000Z', completed_at: '2026-07-17T00:00:00.001Z', status: 'error', response_status: 400, terminal_tool_fired: null, error: { name: 'LlmRequestError', message: 'structured context rejection', status: 400 } };
}
