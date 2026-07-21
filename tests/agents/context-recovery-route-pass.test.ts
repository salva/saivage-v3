import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MemoryCandidateAvailability } from '../../src/agents/candidate-availability.js';
import { InvocationService, type InvocationRequest } from '../../src/agents/invocation-service.js';
import type { Candidate } from '../../src/contracts/provider-candidate.js';
import { NO_FRESHNESS_EFFECTS } from '../../src/application/freshness-effects.js';
import { contextExhausted, invocationProviderRegistry } from '../helpers/invocation-provider-fixture.js';

const roots: string[] = [];
afterEach(() => {
  jest.restoreAllMocks();
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe('authoritative context route-pass ordering', () => {
  it('ends each ordinary route pass at the first context rejection without candidate failover', async () => {
    const first: Candidate = { provider: 'test-a', account: null, model: 'model-a' };
    const second: Candidate = { provider: 'test-b', account: null, model: 'model-b' };
    const calls: string[] = [];
    jest.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      calls.push(new URL(String(input)).hostname.split('.')[0]!);
      return contextExhausted();
    });
    const service = invocationService([first, second]);
    const request: InvocationRequest = { inputId: '00000000-0000-4000-8000-000000000001', role: 'planner', sessionId: 'planner:project', systemPrompt: 'system', providerConversation: { sourceSessionId: 'planner:project', messages: [] }, tools: [], terminalToolNames: [], modelParams: { maxTokens: 100 }, capabilityRequest: {}, candidateChain: [first, second] };

    await expect(service.invokeWithRecovery(request)).rejects.toMatchObject({ failure: { kind: 'input_context_exhausted' }, provider_exchanges: [{ attempt_index: 0 }] });
    expect(calls).toEqual(['test-a']);

    await expect(service.invokeWithRecovery({ ...request, providerConversation: { sourceSessionId: 'planner:project', messages: [] } })).rejects.toMatchObject({ failure: { kind: 'input_context_exhausted' }, provider_exchanges: [{ attempt_index: 0 }] });
    expect(calls).toEqual(['test-a', 'test-a']);
  });
});

function invocationService(candidates: Candidate[]): InvocationService {
  const root = mkdtempSync(join(tmpdir(), 'saivage-context-route-pass-'));
  roots.push(root);
  return new InvocationService({ projectRoot: root, freshness: NO_FRESHNESS_EFFECTS, registry: invocationProviderRegistry(candidates), router: { getLastCapabilitySkips: () => [] } as never, candidateAvailability: new MemoryCandidateAvailability() });
}
