import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ProviderTurnFailure } from '../../../src/agents/llm-contracts.js';
import { LlmRequestError } from '../../../src/contracts/llm-failure.js';
import {
  AdmittedProviderTurnFailure,
  ordinaryAdmittedExecutionAuthority,
  type SuspendedAdmittedExecution,
} from '../../../src/agents/invocation-admission.js';
import type { ProviderExchangeAttempt } from '../../../src/contracts/provider-exchange.js';
import { PublicationOutcomeUnknownError } from '../../../src/contracts/index.js';
import { readConversation } from '../../../src/persistence/conversation-file.js';
import { ConversationLLMActor, LastChanceSummaryProviderUnavailableError, type CompactorPort, type LLMProviderPort } from '../../../src/runtime/actors/llm-actor.js';
import { prepareCompaction } from '../../../src/runtime/actors/compaction/compactor.js';
import { buildPreparedInvocationContext } from '../../../src/runtime/actors/context/context-blocks.js';
import type { PreparedLlmInvocationInput } from '../../../src/runtime/actors/llm-invocation.js';
import { RuntimeGate } from '../../../src/runtime/runtime-gate.js';
import { initProjectTree } from '../../helpers/canonical-project.js';
import { scriptedBindings, scriptedOrdinaryAdmission } from '../../helpers/llm-test-helpers.js';

const CANDIDATE = { provider: 'test', account: null, model: 'test-model' } as const;
const roots: string[] = [];

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe('ConversationLLMActor last-chance summary publication ownership', () => {
  it('publishes summary and triggering attempts once under separate identities and rejects with the fieldless ownership marker', async () => {
    const fixture = actorFixture();
    const summaryFailure = providerFailure('summary-input', 'server_transient');
    fixture.compact.mockImplementation(async ({ summarizerProvider }) => {
      summarizerProvider.projectProviderExchanges('agent:compaction-summarizer:global', 'summary-input', summaryFailure.provider_exchanges, { assistantOutputIds: [], terminalConversationOutputId: null });
      throw summaryFailure;
    });

    let rejection: unknown;
    try { await fixture.actor.turn(fixture.input, undefined, jest.fn()); }
    catch (error) { rejection = error; }

    expect(rejection).toBeInstanceOf(LastChanceSummaryProviderUnavailableError);
    expect((rejection as Error).cause).toBe(summaryFailure);
    expect(rejection).not.toBeInstanceOf(ProviderTurnFailure);
    expect(Object.keys(rejection as object)).toEqual(['name']);
    expect(rejection).not.toHaveProperty('provider_exchanges');
    expect(rejection).not.toHaveProperty('failure_phase');
    expect(rejection).not.toHaveProperty('candidate');
    expect(fixture.summaryProjection).toHaveBeenCalledTimes(1);
    expect(fixture.summaryProjection).toHaveBeenCalledWith('agent:compaction-summarizer:global', 'summary-input', expect.any(Array), { assistantOutputIds: [], terminalConversationOutputId: null });
    expect(fixture.plannerProjection).toHaveBeenCalledTimes(1);
    expect(fixture.plannerProjection).toHaveBeenCalledWith(fixture.input.sessionId, fixture.input.inputId, expect.arrayContaining([expect.objectContaining({ source_input_id: fixture.input.inputId, attempt_index: 0 })]), { assistantOutputIds: [], terminalConversationOutputId: null });
    const conversation = readConversation(fixture.root, fixture.input.sessionId);
    expect(conversation.sourceRows.some((row) => row.kind === 'model_issue')).toBe(false);
    expect(conversation.effectiveCompactedHistory).toBeNull();
  });

  it.each([
    new Error('planner exchange publication failed'),
    new PublicationOutcomeUnknownError(),
  ])('keeps triggering-attempt publication failure authoritative instead of creating the marker', async (publicationFailure) => {
    const fixture = actorFixture(publicationFailure);
    const summaryFailure = providerFailure('summary-input', 'server_transient');
    fixture.compact.mockRejectedValue(summaryFailure);

    await expect(fixture.actor.turn(fixture.input, undefined, jest.fn())).rejects.toBe(publicationFailure);
    expect(fixture.plannerProjection).toHaveBeenCalledTimes(1);
    expect(readConversation(fixture.root, fixture.input.sessionId).sourceRows.some((row) => row.kind === 'model_issue')).toBe(false);
    if (publicationFailure instanceof PublicationOutcomeUnknownError)
      expect(fixture.publicationOutcomeUnknown).toHaveBeenCalledWith(publicationFailure);
  });
});

describe('ConversationLLMActor local exact-admission transition', () => {
  it('invokes one local_exact_admission compaction before turn-start and sends only the re-admitted projection', async () => {
    const fixture = actorFixture();
    const compactedProjection = copyProjection(fixture.input.providerConversation);
    fixture.compact.mockResolvedValue({ kind: 'compacted', providerConversation: compactedProjection, estimatedProviderMessageTokens: 1 });
    fixture.prepare.mockReturnValueOnce(rejectedCompactionAdmission()).mockReturnValueOnce(scriptedOrdinaryAdmission());
    fixture.execute.mockImplementation(async () => ({ result: { kind: 'message' as const, content: 'post-compaction answer' }, provider_exchanges: [attempt(fixture.input.inputId, 'ok', 0)] }));
    const outcome = await fixture.actor.turn(fixture.input, undefined, jest.fn());
    expect(outcome.type).toBe('result');
    expect(fixture.compact).toHaveBeenCalledTimes(1);
    expect(fixture.compact.mock.calls[0]![0]).toMatchObject({ strategy: 'local_exact_admission' });
    expect(fixture.compact.mock.calls[0]![0].input).toBe(fixture.input);
    expect(fixture.prepare).toHaveBeenCalledTimes(2);
    expect(fixture.prepare.mock.calls[1]![0].providerConversation).toBe(compactedProjection);
    expect(fixture.prepare.mock.calls[1]![0].systemPrompt).toBe(fixture.input.systemPrompt);
    expect(fixture.prepare.mock.calls[1]![0].preparedCompaction).toBe(fixture.input.preparedCompaction);
    expect(fixture.execute).toHaveBeenCalledTimes(1);
    expect(outcome).toMatchObject({ type: 'result', result: { content: 'post-compaction answer' } });
    expect(readConversation(fixture.root, fixture.input.sessionId).sourceRows.some((row) => row.kind === 'activity')).toBe(true);
  });

  it('terminates with a bounded LocalExactAdmissionError before turn-start or provider I/O when the second admission still does not fit', async () => {
    const fixture = actorFixture();
    fixture.prepare.mockReturnValueOnce(rejectedCompactionAdmission()).mockReturnValueOnce(rejectedCompactionAdmission());
    fixture.compact.mockResolvedValue({ kind: 'compacted', providerConversation: compactedProjectionOf(fixture), estimatedProviderMessageTokens: 1 });
    await expect(fixture.actor.turn(fixture.input, undefined, jest.fn())).rejects.toMatchObject({ name: 'LocalExactAdmissionError', localCompactionAttempted: true });
    expect(fixture.compact).toHaveBeenCalledTimes(1);
    expect(fixture.execute).not.toHaveBeenCalled();
    const rows = readConversation(fixture.root, fixture.input.sessionId).sourceRows;
    expect(rows.some((row) => row.kind === 'activity')).toBe(false);
    expect(rows.some((row) => row.kind === 'model_issue')).toBe(false);
  });

  it('terminates without compaction when no candidate is size-fixable', async () => {
    const fixture = actorFixture();
    fixture.prepare.mockReturnValueOnce({ kind: 'local_admission_failed', routePass: fixture.input.routePass, candidates: [], bindings: scriptedBindings() });
    await expect(fixture.actor.turn(fixture.input, undefined, jest.fn())).rejects.toMatchObject({ name: 'LocalExactAdmissionError', localCompactionAttempted: false });
    expect(fixture.compact).not.toHaveBeenCalled();
    expect(fixture.execute).not.toHaveBeenCalled();
    expect(readConversation(fixture.root, fixture.input.sessionId).sourceRows.some((row) => row.kind === 'activity')).toBe(false);
  });

  it('terminates when local compaction finds no smaller projection', async () => {
    const fixture = actorFixture();
    fixture.prepare.mockReturnValueOnce(rejectedCompactionAdmission());
    fixture.compact.mockResolvedValue({ kind: 'no_smaller_projection', rejectedEstimatedProviderMessageTokens: 10, smallestCandidateEstimatedProviderMessageTokens: null });
    await expect(fixture.actor.turn(fixture.input, undefined, jest.fn())).rejects.toMatchObject({ name: 'LocalExactAdmissionError', localCompactionAttempted: true });
    expect(fixture.compact).toHaveBeenCalledTimes(1);
    expect(fixture.execute).not.toHaveBeenCalled();
  });
});

describe('ConversationLLMActor authoritative admitted recovery', () => {
  it('holds the suspension untouched, compacts authoritatively once, and returns the same suspension to recovery preparation', async () => {
    const fixture = actorFixture();
    const compactedProjection = compactedProjectionOf(fixture);
    const compacted = { kind: 'compacted' as const, providerConversation: compactedProjection, estimatedProviderMessageTokens: 1 };
    fixture.compact.mockResolvedValue(compacted);
    const resumeCompletion = { result: { kind: 'message' as const, content: 'recovered' }, provider_exchanges: [attempt(fixture.input.inputId, 'error', 0), attempt(fixture.input.inputId, 'ok', 1)] };
    fixture.prepareRecovery.mockReturnValue({ kind: 'recovery_prepared' } as never);
    fixture.resume.mockResolvedValue(resumeCompletion);
    const outcome = await fixture.actor.turn(fixture.input, undefined, jest.fn());
    expect(outcome).toMatchObject({ type: 'result', result: { content: 'recovered' } });
    expect(fixture.compact).toHaveBeenCalledTimes(1);
    expect(fixture.compact.mock.calls[0]![0]).toMatchObject({ strategy: 'authoritative_context_recovery' });
    expect(fixture.prepareRecovery).toHaveBeenCalledTimes(1);
    const recoveryArgs = fixture.prepareRecovery.mock.calls[0]![0];
    expect(recoveryArgs.suspension).toBe(fixture.capturedSuspension);
    expect(recoveryArgs.input.providerConversation).toBe(compactedProjection);
    expect(recoveryArgs.input.preparedCompaction).toBe(fixture.input.preparedCompaction);
    expect(fixture.resume).toHaveBeenCalledTimes(1);
    expect(fixture.pinnedPreflight).not.toHaveBeenCalled();
  });

  it('settles a recovery preparation terminal failure as an ordinary error outcome without retry transport', async () => {
    const fixture = actorFixture();
    fixture.compact.mockResolvedValue({ kind: 'compacted', providerConversation: compactedProjectionOf(fixture), estimatedProviderMessageTokens: 1 });
    const terminal = providerFailure(fixture.input.inputId, 'input_context_exhausted');
    fixture.prepareRecovery.mockImplementation(() => { throw terminal; });
    const outcome = await fixture.actor.turn(fixture.input, undefined, jest.fn());
    expect(outcome).toMatchObject({ type: 'error', error: 'input_context_exhausted' });
    expect(fixture.resume).not.toHaveBeenCalled();
  });

  it('fails closed when recovery tries to suspend a second time', async () => {
    const fixture = actorFixture();
    fixture.compact.mockResolvedValue({ kind: 'compacted', providerConversation: compactedProjectionOf(fixture), estimatedProviderMessageTokens: 1 });
    fixture.resume.mockRejectedValue(new AdmittedProviderTurnFailure(providerFailure(fixture.input.inputId, 'input_context_exhausted'), fixture.capturedSuspension!));
    await expect(fixture.actor.turn(fixture.input, undefined, jest.fn())).rejects.toThrow(/cannot suspend a second time/);
  });
});

function compactedProjectionOf(fixture: ReturnType<typeof actorFixture>): PreparedLlmInvocationInput['providerConversation'] {
  return copyProjection(fixture.input.providerConversation);
}

function copyProjection(projection: PreparedLlmInvocationInput['providerConversation']): PreparedLlmInvocationInput['providerConversation'] {
  return { sourceSessionId: projection.sourceSessionId, messages: [...projection.messages] } as PreparedLlmInvocationInput['providerConversation'];
}

function rejectedCompactionAdmission() {
  return { kind: 'local_compaction_required' as const, routePass: { kind: 'ordinary' as const, candidateChain: [CANDIDATE] }, candidates: [], bindings: scriptedBindings() };
}

function actorFixture(plannerPublicationFailure?: Error) {
  const root = mkdtempSync(join(tmpdir(), 'saivage-last-chance-summary-'));
  roots.push(root);
  initProjectTree(root);
  const input = invocation();
  const firstFailure = providerFailure(input.inputId, 'input_context_exhausted');
  const plannerProjection = jest.fn(() => {
    if (plannerPublicationFailure) throw plannerPublicationFailure;
  });
  const summaryProjection = jest.fn();
  const compact = jest.fn<CompactorPort['compact']>();
  const publicationOutcomeUnknown = jest.fn((_error: PublicationOutcomeUnknownError) => undefined);
  const prepare = jest.fn<LLMProviderPort['preparePrimaryRequestAdmission']>(() => scriptedOrdinaryAdmission());
  const execute = jest.fn<LLMProviderPort['executeAdmittedWithRecovery']>();
  const prepareRecovery = jest.fn<LLMProviderPort['prepareAdmittedRecovery']>();
  const resume = jest.fn<LLMProviderPort['resumeAdmittedExecution']>();
  const pinnedPreflight = jest.fn<LLMProviderPort['preflightPinnedContentPolicyRequest']>();
  let capturedSuspension: SuspendedAdmittedExecution | undefined;
  const provider: LLMProviderPort = {
    preparePrimaryRequestAdmission: prepare,
    executeAdmittedWithRecovery: execute,
    prepareAdmittedRecovery: prepareRecovery,
    resumeAdmittedExecution: resume,
    preflightPinnedContentPolicyRequest: pinnedPreflight,
    executePinnedContentPolicyRequest: () => Promise.reject(new Error('unexpected pinned execution')),
    projectProviderExchanges: plannerProjection,
  };
  const suspension: SuspendedAdmittedExecution = Object.freeze({
    authority: ordinaryAdmittedExecutionAuthority([CANDIDATE]),
    records: Object.freeze([Object.freeze({ identity: CANDIDATE, routeIndex: 0, state: Object.freeze({ kind: 'context_failed', attempts: 1, failure: firstFailure }) })]),
    contextFailedIdentity: CANDIDATE,
    settledProviderAttempts: Object.freeze([attempt(input.inputId, 'error', 0)]),
    deadlineMs: Number.MAX_SAFE_INTEGER,
    bindings: scriptedBindings(),
  });
  capturedSuspension = suspension;
  execute.mockImplementation(async () => { throw new AdmittedProviderTurnFailure(firstFailure, suspension); });
  const actor = new ConversationLLMActor({
    purpose: { kind: 'autonomous-card', cardId: 'project' },
    gate: new RuntimeGate(),
    agentId: input.sessionId,
    provider,
    conversations: { projectRoot: root },
    compactor: { shouldCompact: () => false, compact },
    summarizerProvider: { candidate: CANDIDATE, serializeSummaryRequest: () => { throw new Error('unexpected summary provider serialization'); }, completeTurn: jest.fn(async () => { throw new Error('unexpected summary provider call'); }), projectProviderExchanges: summaryProjection },
    fatalPort: { publicationOutcomeUnknown: publicationOutcomeUnknown as unknown as (error: PublicationOutcomeUnknownError) => never },
  });
  return { root, input, actor, compact, prepare, execute, prepareRecovery, resume, pinnedPreflight, plannerProjection, summaryProjection, publicationOutcomeUnknown, capturedSuspension };
}

function invocation(): PreparedLlmInvocationInput {
  const sessionId = 'agent:planner:project' as const;
  const preparedCompaction = prepareCompaction({ input_budget_tokens: 1000, trigger_fraction: 0.8, completion_reserve_fraction: 0.2, merge_line_fraction: 0.3, summary_line_fraction: 0.5, escalate_merge_line_fraction: 0.4, escalate_summary_line_fraction: 0.6, snap: 'compact_straddler' }, 'system', []);
  return {
    inputId: '00000000-0000-4000-8000-000000000001', agentId: sessionId, agentName: 'planner', sessionId,
    systemPrompt: 'system', providerConversation: { sourceSessionId: sessionId, messages: [] }, tools: [], compiledToolContracts: [], terminalToolNames: [], modelParams: { temperature: 0 },
    preparedCompaction,
    preparedContext: buildPreparedInvocationContext({ instructionText: 'system', terminalToolNames: [], compiledTools: [], dynamicBlocks: [], preparedCompaction }),
    capabilityRequest: {}, routePass: { kind: 'ordinary', candidateChain: [CANDIDATE] }, episodeContext: {},
  };
}

function providerFailure(inputId: string, kind: 'input_context_exhausted' | 'server_transient'): ProviderTurnFailure {
  return new ProviderTurnFailure({
    failure_phase: 'provider_attempt',
    provider_exchanges: [attempt(inputId, 'error', 0)],
    originalFailure: new LlmRequestError({ kind, provider: 'test', status: 200, message: kind }),
    candidate: CANDIDATE,
  });
}

function attempt(source_input_id: string, status: 'ok' | 'error', attempt_index: number): ProviderExchangeAttempt {
  const common = { contract_id: 'test.v1', contract_name: 'test', transport: 'generic' as const, provider: 'test', model: 'test-model', source_input_id, attempt_index, request_params: { endpoint: 'https://example.invalid', method: 'POST', stream: false, offered_tools_count: 0, temperature: 0, max_tokens: 10 }, started_at: '2026-08-10T00:00:00.000Z', completed_at: '2026-08-10T00:00:01.000Z', terminal_tool_fired: null };
  return status === 'ok' ? { ...common, status } : { ...common, status, error: { name: 'LlmRequestError', message: 'provider failed' } };
}
