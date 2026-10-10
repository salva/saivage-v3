import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { initProjectTree } from '../helpers/canonical-project.js';
import { analystCapacityFixture, capacityAdmission } from '../helpers/analyst-capacity-fixtures.js';
import { scriptedAdmissionProvider } from '../helpers/llm-test-helpers.js';
import { AdmittedRecoveryIntegrityError, LocalExactAdmissionError, NO_FRESHNESS_EFFECTS, ProviderTurnFailure } from '../../src/contracts/index.js';
import { createInvocationServiceProvider, executeInternalSummaryTurn } from '../../src/application/invocation-service-provider.js';
import { InvocationService } from '../../src/agents/invocation-service.js';
import { MemoryCandidateAvailability } from '../../src/agents/candidate-availability.js';
import { invocationProviderRegistry, contextExhausted, chatSuccess } from '../helpers/invocation-provider-fixture.js';
import { providerExchangeFile } from '../../src/persistence/layout.js';
import type { CompactorPort, LLMProviderPort } from '../../src/runtime/actors/llm-actor.js';
import { CompactionSummaryConstructionError } from '../../src/runtime/actors/compaction/compactor.js';
import { buildSummaryRequestInput } from '../../src/runtime/actors/compaction/summarizer.js';
import { readConversation } from '../../src/persistence/conversation-file.js';
import { defineTool, executedToolOutcome, OPERATIONAL_RESULT_POLICY_TEMPLATE } from '../../src/tools/invocation.js';
import { toolSucceeded } from '../../src/contracts/tool-result.js';
import { deferred } from '../../src/runtime/actors/deferred.js';
import { AnalystTurnBusyError } from '../../src/runtime/actors/analyst-session.js';

const roots: string[] = [];
function root() {
  const value = mkdtempSync(join(tmpdir(), 'analyst-capacity-recovery-'));
  roots.push(value);
  initProjectTree(value);
  return value;
}
afterEach(() => { jest.restoreAllMocks(); while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });

describe('retained Analyst primary-local capacity rejection', () => {
  it.each(['initial', 'continuation'] as const)('settles %s rejection without primary error fabrication or replay, then admits a fresh send', async (pass) => {
    const projectRoot = root();
    let reject = true;
    let calls = 0;
    const effect = jest.fn(() => null);
    const tool = defineTool({ name: 'capacity_effect', description: 'One effect', resultPolicyTemplate: OPERATIONAL_RESULT_POLICY_TEMPLATE, inputSchema: z.object({}).strict(), executor: async () => executedToolOutcome('none', toolSucceeded(effect())) });
    const complete = jest.fn(async () => {
      calls++;
      return calls === 1 && pass === 'continuation'
        ? { result: { kind: 'tool_calls' as const, tool_calls: [{ id: 'capacity-call', type: 'function' as const, function: { name: tool.name, arguments: '{}' } }] }, provider_exchanges: [] }
        : { result: { kind: 'message' as const, content: 'fresh success' }, provider_exchanges: [] };
    });
    const base = scriptedAdmissionProvider(complete);
    const prepare = jest.fn<LLMProviderPort['preparePrimaryRequestAdmission']>(async (input, signal) => reject && (pass === 'initial' || calls === 1) ? capacityAdmission() : base.preparePrimaryRequestAdmission(input, signal));
    const { session } = analystCapacityFixture(projectRoot, { provider: { ...base, preparePrimaryRequestAdmission: prepare }, surface: { agentName: 'analyst', tools: new Map([[tool.name, tool]]), providers: [] } });
    await expect(session.submit({ userContent: 'rejected send' })).rejects.toMatchObject({ source: 'primary_local', reason: 'capacity' });
    expect(complete).toHaveBeenCalledTimes(pass === 'initial' ? 0 : 1);
    const rows = readConversation(projectRoot, 'agent:analyst:global').sourceRows;
    expect(rows.filter((row) => row.kind === 'tool_result')).toHaveLength(pass === 'initial' ? 0 : 1);
    expect(rows.filter((row) => row.kind === 'model_issue')).toHaveLength(0);
    expect(rows.filter((row) => row.role === 'user').map((row) => row.content)).toEqual(['rejected send']);
    reject = false;
    await expect(session.submit({ userContent: 'fresh explicit send' })).resolves.toMatchObject({ sessionId: 'agent:analyst:global' });
    expect(effect).toHaveBeenCalledTimes(pass === 'initial' ? 0 : 1);
    expect(readConversation(projectRoot, 'agent:analyst:global').sourceRows.filter((row) => row.kind === 'tool_result')).toHaveLength(pass === 'initial' ? 0 : 1);
    expect(prepare).toHaveBeenCalledTimes(pass === 'initial' ? 2 : 3);
  });

  it('keeps the outer owner busy through deferred compaction and its completion observer, then reuses only after rejection', async () => {
    const projectRoot = root();
    const started = deferred<void>();
    const finish = deferred<void>();
    let reject = true;
    let observedBusy: Promise<unknown> | undefined;
    let clearing = false;
    const base = scriptedAdmissionProvider(async () => ({ result: { kind: 'message', content: 'fresh' }, provider_exchanges: [] }));
    const compact: CompactorPort['compact'] = async ({ progress }) => {
      progress?.foldStarted();
      started.resolve();
      await finish.promise;
      clearing = true;
      progress?.foldCompleted();
      return { kind: 'no_smaller_projection', rejectedEstimatedProviderMessageTokens: 10000, smallestCandidateEstimatedProviderMessageTokens: null };
    };
    const { session } = analystCapacityFixture(projectRoot, {
      provider: { ...base, preparePrimaryRequestAdmission: async (input, signal) => reject ? capacityAdmission('local_compaction_required') : base.preparePrimaryRequestAdmission(input, signal) },
      compactor: { shouldCompact: () => false, compact },
      runtimeProjectionChanged: () => {
        if (clearing && !observedBusy) observedBusy = session.submit({ userContent: 'observer concurrent send' }).catch((error: unknown) => error);
      },
    });
    const first = session.submit({ userContent: 'first' });
    const rejection = expect(first).rejects.toMatchObject({ source: 'primary_local', reason: 'capacity' });
    await started.promise;
    await expect(session.submit({ userContent: 'concurrent' })).rejects.toBeInstanceOf(AnalystTurnBusyError);
    finish.resolve();
    await rejection;
    expect(await observedBusy).toBeInstanceOf(AnalystTurnBusyError);
    reject = false;
    await expect(session.submit({ userContent: 'after public rejection' })).resolves.toMatchObject({ sessionId: 'agent:analyst:global' });
  });

  it('lets a compaction settlement observer failure supersede capacity and poison the retained owner', async () => {
    const projectRoot = root();
    const sentinel = new Error('settlement observer failed');
    let clearing = false;
    const prepare = jest.fn<LLMProviderPort['preparePrimaryRequestAdmission']>(async () => capacityAdmission('local_compaction_required'));
    const base = scriptedAdmissionProvider(async () => { throw new Error('primary must not run'); });
    const render = jest.fn(() => 'Analyst');
    const { session } = analystCapacityFixture(projectRoot, {
      render, provider: { ...base, preparePrimaryRequestAdmission: prepare },
      compactor: { shouldCompact: () => false, compact: async () => { clearing = true; return { kind: 'no_smaller_projection', rejectedEstimatedProviderMessageTokens: 10000, smallestCandidateEstimatedProviderMessageTokens: null }; } },
      runtimeProjectionChanged: () => { if (clearing) { clearing = false; throw sentinel; } },
    });
    await expect(session.submit({ userContent: 'first' })).rejects.toBe(sentinel);
    await expect(session.submit({ userContent: 'second' })).rejects.toBe(sentinel);
    expect(render).toHaveBeenCalledTimes(1);
    expect(prepare).toHaveBeenCalledTimes(1);
  });

  it('poisons when the clean rejection owner completion observer fails instead of delivering reusable capacity', async () => {
    const projectRoot = root();
    const sentinel = new Error('capacity completion observer failed');
    let rejecting = false;
    const base = scriptedAdmissionProvider(async () => { throw new Error('primary must not run'); });
    const prepare = jest.fn<LLMProviderPort['preparePrimaryRequestAdmission']>(async () => { rejecting = true; return capacityAdmission(); });
    const render = jest.fn(() => 'Analyst');
    const { session } = analystCapacityFixture(projectRoot, {
      render, provider: { ...base, preparePrimaryRequestAdmission: prepare },
      runtimeProjectionChanged: () => { if (rejecting) { rejecting = false; throw sentinel; } },
    });
    await expect(session.submit({ userContent: 'first' })).rejects.toBe(sentinel);
    await expect(session.submit({ userContent: 'second' })).rejects.toBe(sentinel);
    expect(render).toHaveBeenCalledTimes(1);
    expect(prepare).toHaveBeenCalledTimes(1);
  });
});

describe('ineligible summary and configuration failures retain Analyst poison', () => {
  it('retains configuration-only primary admission rejection without fresh preparation', async () => {
    const projectRoot = root();
    const base = scriptedAdmissionProvider(async () => { throw new Error('primary must not run'); });
    const prepare = jest.fn<LLMProviderPort['preparePrimaryRequestAdmission']>(async () => ({
      ...capacityAdmission(), candidates: [{ candidate: { provider: 'test', account: null, model: 'test-model' }, capabilityRequest: {}, capabilityRequestSha256: '0'.repeat(64), kind: 'candidate_ineligible', reason: { kind: 'missing_context_window' } }],
    }));
    const render = jest.fn(() => 'Analyst');
    const { session } = analystCapacityFixture(projectRoot, { render, provider: { ...base, preparePrimaryRequestAdmission: prepare } });
    const rejected = await session.submit({ userContent: 'first' }).catch((error: unknown) => error);
    expect(rejected).toMatchObject({ source: 'primary_local', reason: 'configuration' });
    await expect(session.submit({ userContent: 'second' })).rejects.toBe(rejected);
    expect(render).toHaveBeenCalledTimes(1);
    expect(prepare).toHaveBeenCalledTimes(1);
  });
  it.each(['preventive', 'local'] as const)('preserves genuine executeInternalSummaryTurn capacity identity and provenance through %s compaction', async (strategy) => {
    const projectRoot = root();
    const summaryAdmission = jest.fn(() => capacityAdmission());
    const summaryExecute = jest.fn(async () => { throw new Error('summary provider must not run'); });
    const service = { preparePrimaryRequestAdmission: summaryAdmission, executeSummaryWithRecovery: summaryExecute } as unknown as InvocationService;
    const base = scriptedAdmissionProvider(async () => { throw new Error('primary must not run'); });
    const execute = jest.fn(base.executeAdmittedWithRecovery);
    const prepare = jest.fn<LLMProviderPort['preparePrimaryRequestAdmission']>(async (input, signal) => strategy === 'local' ? capacityAdmission('local_compaction_required') : base.preparePrimaryRequestAdmission(input, signal));
    const render = jest.fn(() => 'Analyst');
    let original: unknown;
    const compact = jest.fn<CompactorPort['compact']>(async ({ input, signal }) => {
      const summaryInput = buildSummaryRequestInput({
        candidate: { provider: 'test', account: null, model: 'test-model' },
        sourceSessionId: input.sessionId,
        instruction: 'Summarize the source conversation.',
        items: [{ label: 'source', role: 'user', content: 'Controlled summary material.' }],
      });
      try {
        await executeInternalSummaryTurn(service, summaryInput, signal, { kind: 'admitted', imageCount: 0, contextUtilizationFraction: .8, requestSha256: '0'.repeat(64), serializedRequest: '{}', estimatedInputTokens: 1, usableInputTokens: 100 });
      } catch (error) { original = error; throw error; }
      throw new Error('summary must reject');
    });
    const { session } = analystCapacityFixture(projectRoot, { render, provider: { ...base, preparePrimaryRequestAdmission: prepare, executeAdmittedWithRecovery: execute }, compactor: { shouldCompact: () => strategy === 'preventive', compact } });
    const rejection = await session.submit({ userContent: 'first' }).catch((error: unknown) => error);
    expect(rejection).toBe(original);
    expect(rejection).toBeInstanceOf(LocalExactAdmissionError);
    expect(rejection).toMatchObject({ source: 'internal_summary', reason: 'capacity' });
    await expect(session.submit({ userContent: 'second' })).rejects.toBe(original);
    expect(render).toHaveBeenCalledTimes(1);
    expect(compact).toHaveBeenCalledTimes(1);
    expect(summaryAdmission).toHaveBeenCalledTimes(1);
    expect(summaryExecute).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
    expect(readConversation(projectRoot, 'agent:analyst:global').sourceRows.filter((row) => row.kind === 'model_issue')).toHaveLength(0);
  });

  it.each(['preventive', 'local'] as const)('keeps %s construction failure poisoning with strategy-specific identity', async (strategy) => {
    const projectRoot = root();
    const construction = new CompactionSummaryConstructionError({ reason: 'fold_limit', invocationCount: 16, correctionCount: 1, cause: new Error('private') });
    const base = scriptedAdmissionProvider(async () => { throw new Error('primary must not run'); });
    const prepare = jest.fn<LLMProviderPort['preparePrimaryRequestAdmission']>(async () => capacityAdmission('local_compaction_required'));
    const compact = jest.fn<CompactorPort['compact']>(async () => { throw construction; });
    const render = jest.fn(() => 'Analyst');
    const { session } = analystCapacityFixture(projectRoot, { render, provider: { ...base, preparePrimaryRequestAdmission: prepare }, compactor: { shouldCompact: () => strategy === 'preventive', compact } });
    const rejection = await session.submit({ userContent: 'first' }).catch((error: unknown) => error);
    if (strategy === 'preventive') expect(rejection).toBe(construction);
    else expect(rejection).toMatchObject({ source: 'primary_local', reason: 'summary_construction', cause: construction });
    await expect(session.submit({ userContent: 'second' })).rejects.toBe(rejection);
    expect(render).toHaveBeenCalledTimes(1);
    expect(compact).toHaveBeenCalledTimes(1);
  });

  it('keeps generic preventive summary failure poisoning', async () => {
    const projectRoot = root();
    const sentinel = new Error('summary failed');
    const compact = jest.fn<CompactorPort['compact']>(async () => { throw sentinel; });
    const { session, complete } = analystCapacityFixture(projectRoot, { compactor: { shouldCompact: () => true, compact } });
    await expect(session.submit({ userContent: 'first' })).rejects.toBe(sentinel);
    await expect(session.submit({ userContent: 'second' })).rejects.toBe(sentinel);
    expect(compact).toHaveBeenCalledTimes(1);
    expect(complete).not.toHaveBeenCalled();
  });
});

describe('authoritative re-admission remains separate from local capacity', () => {
  it.each(['mandatory', 'retained_integrity'] as const)('uses genuine service %s rejection with real attempt evidence and the existing owner disposition', async (mode) => {
    const projectRoot = root();
    const a = { provider: 'primary-a', account: null, model: 'model-a' };
    const b = { provider: 'primary-b', account: null, model: 'model-b' };
    const chain = mode === 'mandatory' ? [a] : [a, b];
    const service = new InvocationService({ projectRoot, freshness: NO_FRESHNESS_EFFECTS, registry: invocationProviderRegistry(chain, { 'primary-a': { contextWindowTokens: mode === 'mandatory' ? 5000 : 100000 }, 'primary-b': { contextWindowTokens: 5000 } }), candidateAvailability: new MemoryCandidateAvailability() });
    const fetch = jest.spyOn(globalThis, 'fetch').mockResolvedValueOnce(contextExhausted()).mockResolvedValue(chatSuccess('fresh authoritative send'));
    const provider = createInvocationServiceProvider(service, projectRoot);
    let original: unknown;
    const prepareRecovery = jest.fn<LLMProviderPort['prepareAdmittedRecovery']>(async (args) => {
      try { return await provider.prepareAdmittedRecovery(args); }
      catch (error) { original = error; throw error; }
    });
    const render = jest.fn(() => 'Analyst');
    const compact = jest.fn<CompactorPort['compact']>(async ({ input }) => ({ kind: 'compacted', summaryRefusal: null, providerConversation: { sourceSessionId: input.sessionId, messages: [{ kind: 'synthetic_context', origin: 'dynamic', block_identity: 'controlled-recovery', role: 'system', content: 'x'.repeat(40000) }] }, estimatedProviderMessageTokens: 10000 }));
    const { session } = analystCapacityFixture(projectRoot, { candidateChain: chain, render, provider: { ...provider, prepareAdmittedRecovery: prepareRecovery }, compactor: { shouldCompact: () => false, compact } });
    if (mode === 'mandatory') {
      await expect(session.submit({ userContent: 'first authoritative send' })).resolves.toMatchObject({ sessionId: 'agent:analyst:global' });
      expect(original).toBeInstanceOf(ProviderTurnFailure);
      expect(original).not.toBeInstanceOf(LocalExactAdmissionError);
      expect((original as ProviderTurnFailure).provider_exchanges).toHaveLength(1);
      const rows = readConversation(projectRoot, 'agent:analyst:global').sourceRows;
      expect(rows.filter((row) => row.kind === 'model_issue')).toHaveLength(1);
      expect(rows.some((row) => row.content.startsWith('Analyst LLM unavailable:'))).toBe(true);
      const evidence = readFileSync(providerExchangeFile(projectRoot, 'agent:analyst:global'), 'utf8').trim().split('\n').flatMap((line) => (JSON.parse(line) as { rows: Array<{ type: string }> }).rows).filter((row) => row.type === 'provider_exchange');
      expect(evidence).toHaveLength(1);
      await expect(session.submit({ userContent: 'fresh authoritative send' })).resolves.toMatchObject({ sessionId: 'agent:analyst:global' });
      expect(render).toHaveBeenCalledTimes(2);
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(readConversation(projectRoot, 'agent:analyst:global').sourceRows.some((row) => row.content === 'fresh authoritative send' && row.role === 'assistant')).toBe(true);
    } else {
      const rejected = await session.submit({ userContent: 'first integrity send' }).catch((error: unknown) => error);
      expect(rejected).toBe(original);
      expect(rejected).toBeInstanceOf(AdmittedRecoveryIntegrityError);
      await expect(session.submit({ userContent: 'second integrity send' })).rejects.toBe(original);
      expect(render).toHaveBeenCalledTimes(1);
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(readConversation(projectRoot, 'agent:analyst:global').sourceRows.filter((row) => row.kind === 'model_issue')).toHaveLength(0);
    }
    expect(prepareRecovery).toHaveBeenCalledTimes(1);
    expect(compact).toHaveBeenCalledTimes(1);
    expect(compact.mock.calls[0]![0].strategy).toBe('authoritative_context_recovery');
  });
});
