import { afterEach, describe, expect, it } from '@jest/globals';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AdmittedProviderTurnFailure, InvocationService, type InvocationRequest } from '../../src/agents/invocation-service.js';
import { MemoryCandidateAvailability } from '../../src/agents/candidate-availability.js';
import { ProviderTurnFailure, type LlmCompleteOptions, type ProviderTurnCompletion } from '../../src/agents/llm-contracts.js';
import type { CandidateRequestPlan } from '../../src/agents/candidate-request.js';
import { LlmRequestError } from '../../src/contracts/llm-failure.js';
import type { Candidate } from '../../src/contracts/provider-candidate.js';
import type { ProviderExchangeAttempt } from '../../src/contracts/provider-exchange.js';
import { NO_FRESHNESS_EFFECTS } from '../../src/application/freshness-effects.js';
import { prepareCompaction } from '../../src/runtime/actors/compaction/compactor.js';
import { preparedInvocationContextFixture } from '../helpers/prepared-invocation-context.js';
import { invocationProviderRegistry } from '../helpers/invocation-provider-fixture.js';

const A: Candidate = { provider: 'a', account: null, model: 'a-model' };
const B: Candidate = { provider: 'b', account: null, model: 'b-model' };
const C: Candidate = { provider: 'c', account: null, model: 'c-model' };
const roots: string[] = [];
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });

describe('retained ordinary authoritative context recovery', () => {
  it('does not suspend a pre-provider error merely shaped as input context exhaustion', async () => {
    const service = scripted([A], async () => { throw new ProviderTurnFailure({ failure_phase: 'pre_provider', provider_exchanges: [], originalFailure: new LlmRequestError({ kind: 'input_context_exhausted', provider: 'a', message: 'local setup reported context', status: 400 }), candidate: A }); });
    let observed: unknown;
    try { await service.executeAdmittedWithRecovery(admitted(service, request([A]))); } catch (error) { observed = error; }
    expect(observed).toBeInstanceOf(ProviderTurnFailure);
    expect(observed).not.toBeInstanceOf(AdmittedProviderTurnFailure);
  });

  it('retains rate-limited A and untried C, then retries context-failed B first', async () => {
    const calls: string[] = [];
    const service = scripted([A, B, C], async (_request, plan) => {
      calls.push(plan.candidate.provider);
      if (calls.length === 1) throw failure(plan.candidate, 'rate_limit');
      if (calls.length === 2) throw failure(plan.candidate, 'input_context_exhausted');
      return success(plan.candidate);
    });
    const value = request([A, B, C]);
    const admission = admitted(service, value);
    let suspension!: AdmittedProviderTurnFailure['suspension'];
    try { await service.executeAdmittedWithRecovery(admission); } catch (error) { if (!(error instanceof AdmittedProviderTurnFailure)) throw error; suspension = error.suspension; }
    expect(suspension.diagnostic.stateCounts).toMatchObject({ retry_waiting: 1, context_failed: 1, untried: 1 });
    await expect(service.resumeSuspendedAfterCompaction(suspension, value)).resolves.toMatchObject({ result: { kind: 'message', content: 'b' } });
    expect(calls).toEqual(['a', 'b', 'b']);
  });

  it('retains temporarily unavailable A while B context-fails and retries B first', async () => {
    const availability = new MemoryCandidateAvailability();
    availability.markFailed(A, { state: 'COOLING', untilMs: Date.now() + 60_000, reason: 'server_transient' });
    const calls: string[] = [];
    const service = scripted([A, B, C], async (_request, plan) => {
      calls.push(plan.candidate.provider);
      if (calls.length === 1) throw failure(plan.candidate, 'input_context_exhausted');
      return success(plan.candidate);
    }, availability);
    const value = request([A, B, C]);
    let suspension!: AdmittedProviderTurnFailure['suspension'];
    try { await service.executeAdmittedWithRecovery(admitted(service, value)); } catch (error) { if (!(error instanceof AdmittedProviderTurnFailure)) throw error; suspension = error.suspension; }
    expect(suspension.contextFailedIdentity).toEqual(B);
    expect(suspension.diagnostic.stateCounts).toMatchObject({ temporarily_unavailable: 1, context_failed: 1, untried: 1 });
    await service.resumeSuspendedAfterCompaction(suspension, value);
    expect(calls).toEqual(['b', 'b']);
  });

  it('keeps an exhausted A excluded while retaining untried C around context-failed B', async () => {
    const availability = new MemoryCandidateAvailability();
    availability.markFailed(A, { state: 'BLOCKED_UNTIL', untilMs: Date.now() + 60_000, reason: 'auth_permanent' });
    const calls: string[] = [];
    const service = scripted([A, B, C], async (_request, plan) => { calls.push(plan.candidate.provider); if (calls.length === 1) throw failure(plan.candidate, 'input_context_exhausted'); return success(plan.candidate); }, availability);
    const value = request([A, B, C]);
    let suspension!: AdmittedProviderTurnFailure['suspension'];
    try { await service.executeAdmittedWithRecovery(admitted(service, value)); } catch (error) { if (!(error instanceof AdmittedProviderTurnFailure)) throw error; suspension = error.suspension; }
    expect(suspension.diagnostic.stateCounts).toMatchObject({ exhausted: 1, context_failed: 1, untried: 1 });
    await service.resumeSuspendedAfterCompaction(suspension, value);
    expect(calls).toEqual(['b', 'b']);
    expect(calls).not.toContain('a');
  });

  it('never reopens an originally capability-ineligible identity after compaction', async () => {
    const calls: string[] = [];
    const projectRoot = root();
    const service = new ScriptedInvocationService({ projectRoot, registry: invocationProviderRegistry([A, B, C], (candidate) => candidate === B ? { toolsMode: 'unsupported' } : {}), candidateAvailability: new MemoryCandidateAvailability(), freshness: NO_FRESHNESS_EFFECTS }, async (_request, plan) => {
      calls.push(plan.candidate.provider);
      if (calls.length === 1) throw failure(plan.candidate, 'input_context_exhausted');
      return success(plan.candidate);
    });
    const value = request([A, B, C], { requiresTools: true });
    const admission = admitted(service, value);
    expect(admission.executionAuthority.admittedCandidateIdentities).toEqual([A, C]);
    let suspension!: AdmittedProviderTurnFailure['suspension'];
    try { await service.executeAdmittedWithRecovery(admission); } catch (error) { if (!(error instanceof AdmittedProviderTurnFailure)) throw error; suspension = error.suspension; }
    await service.resumeSuspendedAfterCompaction(suspension, value);
    expect(calls).toEqual(['a', 'a']);
    expect(calls).not.toContain('b');
  });

  it('rejects malformed or already-consumed suspension before retry transport', async () => {
    const calls: string[] = [];
    const service = scripted([A], async (_request, plan) => { calls.push(plan.candidate.provider); if (calls.length === 1) throw failure(plan.candidate, 'input_context_exhausted'); return success(plan.candidate); });
    const value = request([A]);
    let suspension!: AdmittedProviderTurnFailure['suspension'];
    try { await service.executeAdmittedWithRecovery(admitted(service, value)); } catch (error) { if (!(error instanceof AdmittedProviderTurnFailure)) throw error; suspension = error.suspension; }
    await expect(service.resumeSuspendedAfterCompaction({} as never, value)).rejects.toThrow();
    await service.resumeSuspendedAfterCompaction(suspension, value);
    await expect(service.resumeSuspendedAfterCompaction(suspension, value)).rejects.toThrow(/already been resumed/);
    expect(calls).toEqual(['a', 'a']);
  });
});

class ScriptedInvocationService extends InvocationService {
  constructor(config: ConstructorParameters<typeof InvocationService>[0], readonly script: (request: InvocationRequest, plan: CandidateRequestPlan) => Promise<ProviderTurnCompletion>) { super(config); }
  protected override executePlan(request: InvocationRequest, plan: CandidateRequestPlan, _options: LlmCompleteOptions): Promise<ProviderTurnCompletion> { return this.script(request, plan); }
}

function scripted(candidates: Candidate[], script: (request: InvocationRequest, plan: CandidateRequestPlan) => Promise<ProviderTurnCompletion>, availability = new MemoryCandidateAvailability()) {
  return new ScriptedInvocationService({ projectRoot: root(), registry: invocationProviderRegistry(candidates), candidateAvailability: availability, freshness: NO_FRESHNESS_EFFECTS }, script);
}
function root() { const value = mkdtempSync(join(tmpdir(), 'retained-context-')); roots.push(value); return value; }
function admitted(service: InvocationService, value: InvocationRequest) { const result = service.preparePrimaryRequestAdmission(value); if (result.kind !== 'admitted') throw new Error(`fixture not admitted: ${result.kind}`); return result; }
function request(candidates: Candidate[], capabilityRequest: InvocationRequest['capabilityRequest'] = {}): InvocationRequest { return { inputId: '00000000-0000-4000-8000-000000000001', agentName: 'planner', sessionId: 'agent:planner:project', ...preparedInvocationContextFixture(), providerConversation: { sourceSessionId: 'agent:planner:project', messages: [] }, modelParams: { temperature: 0 }, preparedCompaction: prepareCompaction({ input_budget_tokens: 10_000, trigger_fraction: .8, completion_reserve_fraction: .2, merge_line_fraction: .3, summary_line_fraction: .5, escalate_merge_line_fraction: .4, escalate_summary_line_fraction: .6, snap: 'compact_straddler' }, 'system', [], 100), capabilityRequest, routePass: { kind: 'ordinary', candidateChain: candidates } }; }
function success(candidate: Candidate): ProviderTurnCompletion { return { result: { kind: 'message', content: candidate.provider }, provider_exchanges: [exchange(candidate, 'ok')] }; }
function failure(candidate: Candidate, kind: 'rate_limit' | 'input_context_exhausted'): ProviderTurnFailure { const originalFailure = new LlmRequestError(kind === 'rate_limit' ? { kind, provider: candidate.provider, message: kind, status: 429, retryAfterMs: 60_000 } : { kind, provider: candidate.provider, message: kind, status: 400 }); return new ProviderTurnFailure({ failure_phase: 'provider_attempt', provider_exchanges: [exchange(candidate, 'error')], originalFailure, candidate }); }
function exchange(candidate: Candidate, status: 'ok' | 'error'): ProviderExchangeAttempt { const common = { contract_id: 'test', contract_name: 'test', transport: 'generic' as const, provider: candidate.provider, model: candidate.model, source_input_id: 'raw', request_params: { endpoint: 'https://example.invalid', method: 'POST' as const, stream: false, offered_tools_count: 0, temperature: 0, max_tokens: 100 }, started_at: '2026-08-17T00:00:00.000Z', completed_at: '2026-08-17T00:00:01.000Z', terminal_tool_fired: null }; return status === 'ok' ? { ...common, status: 'ok' } : { ...common, status: 'error', error: { name: 'LlmRequestError', message: 'failed' } }; }
