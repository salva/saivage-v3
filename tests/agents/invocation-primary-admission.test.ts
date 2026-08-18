import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MemoryCandidateAvailability } from '../../src/agents/candidate-availability.js';
import { InvocationService, type InvocationRequest } from '../../src/agents/invocation-service.js';
import { LocalExactAdmissionError, projectAdmissionDiagnostics } from '../../src/agents/invocation-admission.js';
import { prepareCompaction } from '../../src/runtime/actors/compaction/compactor.js';
import { agentMessageSchema } from '../../src/schemas/index.js';
import type { SaivageConfig } from '../../src/schemas/saivage-config.js';
import type { Candidate } from '../../src/contracts/provider-candidate.js';
import type { ToolDefinition } from '../../src/agents/llm-contracts.js';
import { NO_FRESHNESS_EFFECTS } from '../../src/application/freshness-effects.js';
import { ProviderRegistry } from '../../src/agents/provider.js';
import { DEFAULT_SAIVAGE_CONFIG } from '../../src/agents/default-workflow-config.js';
import { chatSuccess, invocationProviderRegistry, serverUnavailable } from '../helpers/invocation-provider-fixture.js';

const A: Candidate = { provider: 'cand-a', account: null, model: 'model-a' };
const B: Candidate = { provider: 'cand-b', account: null, model: 'model-b' };
const C: Candidate = { provider: 'cand-c', account: null, model: 'model-c' };
const SESSION = 'agent:planner:project';
const TOOL: ToolDefinition = { type: 'function', function: { name: 'probe_tool', description: 'probe', parameters: { type: 'object', properties: {} } } };
const roots: string[] = [];

afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

function request(chain: readonly Candidate[]): InvocationRequest {
  return {
    inputId: '00000000-0000-4000-8000-000000000002',
    agentName: 'planner',
    sessionId: SESSION,
    systemPrompt: 'system',
    providerConversation: { sourceSessionId: SESSION, messages: [] },
    tools: [TOOL],
    terminalToolNames: [],
    modelParams: { temperature: 0 },
    preparedCompaction: prepareCompaction({ input_budget_tokens: 100_000, trigger_fraction: 0.8, completion_reserve_fraction: 0.2, merge_line_fraction: 0.3, summary_line_fraction: 0.5, escalate_merge_line_fraction: 0.4, escalate_summary_line_fraction: 0.6, snap: 'compact_straddler' }, 'system', [TOOL], 2000),
    capabilityRequest: { requiresTools: true, requiresExclusiveToolChoice: true },
    routePass: { kind: 'ordinary', candidateChain: [...chain] },
  };
}

function message(id: string, content: string) {
  return agentMessageSchema.parse({ id, session_id: SESSION, role: 'user', kind: 'text', content, context_policy: { kind: 'content', storage: 'durable', replacement: { kind: 'retain' }, audience: 'primary_and_summarizer', evidence: { kind: 'none' } }, round_id: `r-pre-${'0'.repeat(32)}`, message_index: 0, block_index: 0, timestamp: '2026-08-16T00:00:00.000Z' });
}

function service(candidates: readonly Candidate[], overrides: Record<string, SaivageConfig['providers'][string]['capabilities']> = {}): InvocationService {
  const projectRoot = mkdtempSync(join(tmpdir(), 'saivage-primary-admission-'));
  roots.push(projectRoot);
  return new InvocationService({ projectRoot, freshness: NO_FRESHNESS_EFFECTS, registry: invocationProviderRegistry(candidates, overrides), candidateAvailability: new MemoryCandidateAvailability() });
}

describe('ordinary primary-request local admission', () => {
  it('requests local compaction when a capability-ineligible fitting candidate cannot suppress a compatible oversized one', () => {
    const svc = service([A, B], { 'cand-a': { toolsMode: 'unsupported' }, 'cand-b': { contextWindowTokens: 10 } });
    const admission = svc.preparePrimaryRequestAdmission(request([A, B]));
    expect(admission.kind).toBe('local_compaction_required');
    if (admission.kind !== 'local_compaction_required') throw new Error('unreachable');
    expect(admission.candidates[0]).toMatchObject({ kind: 'candidate_ineligible', reason: { kind: 'capability_mismatch', reasons: ['unsupported_tools_mode'] } });
    expect(admission.candidates[1]).toMatchObject({ kind: 'projection_too_large' });
    const oversized = admission.candidates[1];
    if (oversized.kind !== 'projection_too_large') throw new Error('unreachable');
    expect(oversized.contextWindowTokens).toBe(10);
    expect(oversized.requestHash).toHaveLength(64);
    expect(oversized.inputBudgetTokens).toBe(100_000);
  });

  it('fails locally without compaction when every rejection is non-size-fixable', () => {
    const svc = service([A, B], { 'cand-a': { toolsMode: 'unsupported' }, 'cand-b': { maxOutputTokens: 100 } });
    const admission = svc.preparePrimaryRequestAdmission(request([A, B]));
    expect(admission.kind).toBe('local_admission_failed');
    if (admission.kind !== 'local_admission_failed') throw new Error('unreachable');
    expect(admission.candidates[1]).toMatchObject({ kind: 'candidate_ineligible', reason: { kind: 'max_output_too_small' } });
  });

  it('fails locally for missing declared limits', () => {
    const svc = service([A], { 'cand-a': { contextWindowTokens: undefined, maxOutputTokens: undefined } });
    const admission = svc.preparePrimaryRequestAdmission(request([A]));
    expect(admission.kind).toBe('local_admission_failed');
    if (admission.kind !== 'local_admission_failed') throw new Error('unreachable');
    expect(admission.candidates[0]).toMatchObject({ kind: 'candidate_ineligible', reason: { kind: 'missing_context_window' } });
  });

  it('keeps A capability-ineligible after compaction while the compatible oversized candidate alone becomes admitted', () => {
    const svc = service([A, B], { 'cand-a': { toolsMode: 'unsupported' }, 'cand-b': { contextWindowTokens: 3000 } });
    const big: InvocationRequest = { ...request([A, B]), providerConversation: { sourceSessionId: SESSION, messages: [message('big', 'x'.repeat(8000))] } };
    const first = svc.preparePrimaryRequestAdmission(big);
    expect(first.kind).toBe('local_compaction_required');
    const smaller: InvocationRequest = { ...request([A, B]), providerConversation: { sourceSessionId: SESSION, messages: [message('small', 'compact summary')] } };
    const second = svc.preparePrimaryRequestAdmission(smaller);
    expect(second.kind).toBe('admitted');
    if (second.kind !== 'admitted') throw new Error('unreachable');
    expect(second.candidates[0]).toMatchObject({ kind: 'candidate_ineligible' });
    expect(second.candidates[1]).toMatchObject({ kind: 'admitted' });
    expect(second.executionAuthority.admittedCandidateIdentities).toEqual([B]);
  });

  it('rejects duplicate ordinary candidate identities before admission', () => {
    expect(() => service([A]).preparePrimaryRequestAdmission(request([A, A]))).toThrow(/duplicate configured identity/);
  });

  it('freezes execution authority from admitted verdicts in route order and fails over only among admitted plans', async () => {
    jest.useFakeTimers({ now: 0 });
    const calls: string[] = [];
    jest.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const provider = new URL(String(input)).hostname.split('.')[0]!;
      calls.push(provider);
      return provider === 'cand-a' ? serverUnavailable('a-unavailable') : chatSuccess('c-wins');
    });
    const svc = service([A, B, C], { 'cand-b': { toolsMode: 'unsupported' } });
    const admission = svc.preparePrimaryRequestAdmission(request([A, B, C]));
    expect(admission.kind).toBe('admitted');
    if (admission.kind !== 'admitted') throw new Error('unreachable');
    expect(admission.executionAuthority.admittedCandidateIdentities).toEqual([A, C]);
    expect(admission.executionAuthority.admittedCandidateIdentitiesSha256).toHaveLength(64);
    const pending = svc.executeAdmittedWithRecovery(admission);
    await jest.advanceTimersByTimeAsync(3 * 60_000);
    const completion = await pending;
    expect(completion.result).toMatchObject({ kind: 'message', content: 'c-wins' });
    expect(calls).toEqual(['cand-a', 'cand-a', 'cand-a', 'cand-a', 'cand-c']);
    expect(completion.provider_exchanges.map((attempt) => attempt.attempt_index)).toEqual([0, 1, 2, 3, 4]);
  });

  it('projects bounded diagnostics capped at 32 candidates with 128-byte previews and no account values', () => {
    const longNamed: Candidate = { provider: 'p'.repeat(300), account: null, model: 'm'.repeat(300) };
    const wide = Array.from({ length: 40 }, (_value, index) => ({ provider: `p${String(index).padStart(2, '0')}${'n'.repeat(40)}`, account: null, model: 'model-x' })) as Candidate[];
    const chain = [longNamed, ...wide];
    const projectRoot = mkdtempSync(join(tmpdir(), 'saivage-primary-admission-'));
    roots.push(projectRoot);
    const providers: SaivageConfig['providers'] = {};
    for (const candidate of chain)
      providers[candidate.provider] = { models: [candidate.model], baseUrl: `https://${candidate.provider}.example.test`, apiKey: 'synthetic-test-key', capabilities: { toolsMode: 'unsupported' } };
    const registry = new ProviderRegistry({
      agents: structuredClone(DEFAULT_SAIVAGE_CONFIG.agents) as unknown as SaivageConfig['agents'], analyst_agent: 'analyst',
      models: { routes: { planner: { candidates: ['model-x'], temperature: 0.2, max_tokens: 2000 } }, profiles: {}, equivalents: [], failover: {} },
      providers, server: { port: 8080, host: '127.0.0.1' },
      compaction: { enabled: true, input_budget_tokens: 100_000, trigger_fraction: 0.8, completion_reserve_fraction: 0.2, merge_line_fraction: 0.3, summary_line_fraction: 0.5, escalate_merge_line_fraction: 0.4, escalate_summary_line_fraction: 0.6, snap: 'compact_straddler', summarizer_candidate: chain[0]! },
      card_types: structuredClone(DEFAULT_SAIVAGE_CONFIG.card_types),
    });
    const svc = new InvocationService({ projectRoot, freshness: NO_FRESHNESS_EFFECTS, registry, candidateAvailability: new MemoryCandidateAvailability() });
    const admission = svc.preparePrimaryRequestAdmission(request(chain));
    expect(admission.kind).toBe('local_admission_failed');
    if (admission.kind !== 'local_admission_failed') throw new Error('unreachable');
    const failure = new LocalExactAdmissionError({ localCompactionAttempted: false, diagnostics: projectAdmissionDiagnostics(admission.candidates) });
    expect(failure.message).toContain('local_compaction_attempted=false');
    expect(failure.localCompactionAttempted).toBe(false);
    const diagnostics = failure.diagnostics;
    expect(diagnostics.verdictCounts).toEqual({ admitted: 0, projection_too_large: 0, candidate_ineligible: 41 });
    expect(diagnostics.candidates).toHaveLength(32);
    expect(diagnostics.omittedCandidateCount).toBe(9);
    expect(diagnostics.reasonCounts.capability_mismatch).toBe(41);
    for (const entry of diagnostics.candidates) {
      expect(Buffer.byteLength(entry.providerPreview, 'utf8')).toBeLessThanOrEqual(128);
      expect(Buffer.byteLength(entry.modelPreview, 'utf8')).toBeLessThanOrEqual(128);
      expect(entry.accountPresent).toBe(false);
      expect(entry.candidateIdentitySha256).toHaveLength(64);
    }
    expect(diagnostics.candidates.some((entry) => entry.providerPreview.endsWith('…'))).toBe(true);
    expect(JSON.stringify(diagnostics)).not.toContain('serializedBody');
  });
});
