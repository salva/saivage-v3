import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MemoryCandidateAvailability } from '../../src/agents/candidate-availability.js';
import { InvocationService, type InvocationRequest } from '../../src/agents/invocation-service.js';
import type { Candidate } from '../../src/contracts/provider-candidate.js';
import { NO_FRESHNESS_EFFECTS } from '../../src/application/freshness-effects.js';
import { contextExhausted, invocationProviderRegistry } from '../helpers/invocation-provider-fixture.js';
import { preparedInvocationContextFixture } from '../helpers/prepared-invocation-context.js';
import { prepareCompaction } from '../../src/runtime/actors/compaction/compactor.js';
import { AdmittedProviderTurnFailure } from '../../src/agents/invocation-service.js';

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
    const request: InvocationRequest = { inputId: '00000000-0000-4000-8000-000000000001', agentName: 'planner', sessionId: 'agent:planner:project', ...preparedInvocationContextFixture(), providerConversation: { sourceSessionId: 'agent:planner:project', messages: [] }, modelParams: { temperature: 0 }, preparedCompaction: prepareCompaction({input_budget_tokens:1000,trigger_fraction:.8,completion_reserve_fraction:.2,merge_line_fraction:.3,summary_line_fraction:.5,escalate_merge_line_fraction:.4,escalate_summary_line_fraction:.6,snap:'compact_straddler'},'system',[],100), capabilityRequest: {}, routePass:{kind:'ordinary',candidateChain:[first, second]} };
    const admission = service.preparePrimaryRequestAdmission(request);
    if (admission.kind !== 'admitted') throw new Error('fixture not admitted');

    await expect(service.executeAdmittedWithRecovery(admission)).rejects.toBeInstanceOf(AdmittedProviderTurnFailure);
    expect(calls).toEqual(['test-a']);

    const secondAdmission = service.preparePrimaryRequestAdmission({ ...request, providerConversation: { sourceSessionId: 'agent:planner:project', messages: [] } });
    if (secondAdmission.kind !== 'admitted') throw new Error('fixture not admitted');
    await expect(service.executeAdmittedWithRecovery(secondAdmission)).rejects.toBeInstanceOf(AdmittedProviderTurnFailure);
    expect(calls).toEqual(['test-a', 'test-a']);
  });
});

function invocationService(candidates: Candidate[]): InvocationService {
  const root = mkdtempSync(join(tmpdir(), 'saivage-context-route-pass-'));
  roots.push(root);
  return new InvocationService({ projectRoot: root, freshness: NO_FRESHNESS_EFFECTS, registry: invocationProviderRegistry(candidates), candidateAvailability: new MemoryCandidateAvailability() });
}
