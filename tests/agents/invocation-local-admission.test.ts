import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { InvocationService, type InvocationRequest } from '../../src/agents/invocation-service.js';
import { MemoryCandidateAvailability } from '../../src/agents/candidate-availability.js';
import { NO_FRESHNESS_EFFECTS } from '../../src/application/freshness-effects.js';
import { prepareCompaction } from '../../src/runtime/actors/compaction/compactor.js';
import { preparedInvocationContextFixture } from '../helpers/prepared-invocation-context.js';
import { invocationProviderRegistry } from '../helpers/invocation-provider-fixture.js';
import type { Candidate } from '../../src/contracts/provider-candidate.js';

const roots: string[] = [];
afterEach(() => { jest.restoreAllMocks(); while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });

const A: Candidate = { provider: 'a', account: null, model: 'a-model' };
const B: Candidate = { provider: 'b', account: null, model: 'b-model' };
const C: Candidate = { provider: 'c', account: null, model: 'c-model' };

describe('ordinary exact local admission', () => {
  it('lets an ineligible fitting candidate neither cause nor suppress compaction for a compatible oversized candidate', () => {
    const service = createService([A, B], (candidate) => candidate === A
      ? { toolsMode: 'unsupported', contextWindowTokens: 100_000 }
      : { toolsMode: 'native', contextWindowTokens: 80 });
    const result = service.preparePrimaryRequestAdmission(request([A, B], { requiresTools: true }, 1_000));
    expect(result.kind).toBe('local_compaction_required');
    expect(result.candidates.map((entry) => entry.kind)).toEqual(['candidate_ineligible', 'projection_too_large']);
    expect(result.candidates[0]).toMatchObject({ reason: { kind: 'capability_mismatch', reasons: ['unsupported_tools_mode'] } });
    expect(result.diagnostic.counts).toMatchObject({ capability_mismatch: 1, projection_too_large: 1 });
  });

  it('freezes only admitted identities in original route order and excludes capability/size rejects', () => {
    const service = createService([A, B, C], (candidate) => candidate === B ? { exclusiveToolChoiceSupport: 'unsupported' } : {});
    const result = service.preparePrimaryRequestAdmission(request([A, B, C], { requiresExclusiveToolChoice: true }, 10_000));
    expect(result.kind).toBe('admitted');
    if (result.kind !== 'admitted') return;
    expect(result.candidates.map((entry) => entry.kind)).toEqual(['admitted', 'candidate_ineligible', 'admitted']);
    expect(result.executionAuthority.admittedCandidateIdentities).toEqual([A, C]);
    expect(result.plans.map((plan) => plan.candidate)).toEqual([A, C]);
    expect(result.executionAuthority.admittedCandidateIdentitiesSha256).toMatch(/^[a-f0-9]{64}$/u);
  });

  it('distinguishes all-size no-fit from all non-size-fixable rejection', () => {
    const oversized = createService([A, B], () => ({ contextWindowTokens: 80 })).preparePrimaryRequestAdmission(request([A, B], {}, 1_000));
    expect(oversized.kind).toBe('local_compaction_required');
    const ineligible = createService([A, B], () => ({ maxOutputTokens: 10 })).preparePrimaryRequestAdmission(request([A, B], {}, 1_000));
    expect(ineligible.kind).toBe('local_admission_failed');
  });

  it('admits a later fitting compatible candidate without admitting an earlier oversized one', () => {
    const service = createService([A, B], (candidate) => ({ contextWindowTokens: candidate === A ? 80 : 100_000 }));
    const result = service.preparePrimaryRequestAdmission(request([A, B], {}, 1_000));
    expect(result.kind).toBe('admitted');
    if (result.kind !== 'admitted') return;
    expect(result.candidates.map((candidate) => candidate.kind)).toEqual(['projection_too_large', 'admitted']);
    expect(result.executionAuthority.admittedCandidateIdentities).toEqual([B]);
  });

  it('bounds and redacts diagnostics for long routes', () => {
    const candidates = Array.from({ length: 40 }, (_, index): Candidate => ({ provider: `provider-${index}-${'x'.repeat(200)}`, account: null, model: `model-${index}-${'y'.repeat(200)}` }));
    const service = createService(candidates, () => ({ toolsMode: 'unsupported' }));
    const result = service.preparePrimaryRequestAdmission(request(candidates, { requiresTools: true }, 10_000));
    expect(result.kind).toBe('local_admission_failed');
    expect(result.diagnostic.candidates).toHaveLength(32);
    expect(result.diagnostic.omittedCandidateCount).toBe(8);
    expect(result.diagnostic.candidates.every((candidate) => candidate.accountPresent === false)).toBe(true);
    expect(Buffer.byteLength(result.diagnostic.candidates[0]!.providerPreview, 'utf8')).toBeLessThanOrEqual(128);
    expect(result.diagnostic.verdictSha256).toMatch(/^[a-f0-9]{64}$/u);
  });

  it('rejects ineligible and oversized pinned candidates without availability or provider I/O', () => {
    const cases: Array<['candidate_ineligible' | 'projection_too_large', Record<string, unknown>, InvocationRequest['capabilityRequest']]> = [
      ['candidate_ineligible', { toolsMode: 'unsupported' }, { requiresTools: true }],
      ['projection_too_large', { contextWindowTokens: 80 }, {}],
    ];
    const fetch = jest.spyOn(globalThis, 'fetch');
    for (const [expected, capabilities, capabilityRequest] of cases) {
      const service = createService([A], () => capabilities);
      const ordinary = request([A], capabilityRequest, 1_000);
      const pinned = { ...ordinary, routePass: { kind: 'pinned-content-policy-retry' as const, candidate: A } };
      const result = service.preflightPinnedContentPolicyRequest(pinned, A);
      expect(result.kind).toBe('rejected');
      if (result.kind === 'rejected') expect(result.verdict.kind).toBe(expected);
    }
    expect(fetch).not.toHaveBeenCalled();
  });
});

function createService(candidates: readonly Candidate[], capabilities: (candidate: Candidate) => Record<string, unknown>): InvocationService {
  const projectRoot = mkdtempSync(join(tmpdir(), 'local-admission-')); roots.push(projectRoot);
  return new InvocationService({ projectRoot, registry: invocationProviderRegistry(candidates, capabilities as never), candidateAvailability: new MemoryCandidateAvailability(), freshness: NO_FRESHNESS_EFFECTS });
}

function request(candidates: readonly Candidate[], capabilityRequest: InvocationRequest['capabilityRequest'], inputBudgetTokens: number): InvocationRequest {
  const policy = { input_budget_tokens: inputBudgetTokens, trigger_fraction: .8, completion_reserve_fraction: .2, merge_line_fraction: .3, summary_line_fraction: .5, escalate_merge_line_fraction: .4, escalate_summary_line_fraction: .6, snap: 'compact_straddler' as const };
  return { inputId: '00000000-0000-4000-8000-000000000001', agentName: 'planner', sessionId: 'agent:planner:project', ...preparedInvocationContextFixture(), providerConversation: { sourceSessionId: 'agent:planner:project', messages: [] }, modelParams: { temperature: 0 }, preparedCompaction: prepareCompaction(policy, 'system', [], Math.max(1, Math.floor(inputBudgetTokens * .1))), capabilityRequest, routePass: { kind: 'ordinary', candidateChain: candidates }, abortSignal: new AbortController().signal };
}
