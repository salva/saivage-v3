import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ProviderTurnFailure } from '../../../src/agents/llm-contracts.js';
import { InvocationService } from '../../../src/agents/invocation-service.js';
import { MemoryCandidateAvailability } from '../../../src/agents/candidate-availability.js';
import { LlmRequestError } from '../../../src/contracts/llm-failure.js';
import {
  AdmittedProviderTurnFailure,
  ordinaryAdmittedExecutionAuthority,
  type SuspendedAdmittedExecution,
} from '../../../src/agents/invocation-admission.js';
import type { ProviderExchangeAttempt } from '../../../src/contracts/provider-exchange.js';
import { PublicationOutcomeUnknownError } from '../../../src/contracts/index.js';
import { appendConversationBatch, readConversation, readCurrentConversationSegment } from '../../../src/persistence/conversation-file.js';
import { ConversationLLMActor, LastChanceSummaryProviderUnavailableError, type CompactorPort, type LLMProviderPort, type LlmTerminalHandoff } from '../../../src/runtime/actors/llm-actor.js';
import { compact, CompactionSummaryConstructionError, prepareCompaction, shouldCompact } from '../../../src/runtime/actors/compaction/compactor.js';
import { internalCompactionSummarySessionId } from '../../../src/runtime/actors/compaction/summarizer.js';
import { buildPreparedInvocationContext } from '../../../src/runtime/actors/context/context-blocks.js';
import { compileInvocationToolContract } from '../../../src/runtime/actors/context/context-blocks.js';
import { providerConversationProjection } from '../../../src/runtime/actors/conversation-session.js';
import type { PreparedLlmInvocationInput } from '../../../src/runtime/actors/llm-invocation.js';
import { OBSERVATIONAL_READ_RESULT_POLICY_TEMPLATE } from '../../../src/tools/invocation.js';
import { RuntimeGate } from '../../../src/runtime/runtime-gate.js';
import { createInvocationServiceProvider } from '../../../src/application/invocation-service-provider.js';
import { NO_FRESHNESS_EFFECTS } from '../../../src/application/freshness-effects.js';
import { appLogFile } from '../../../src/persistence/layout.js';
import { agentMessageSchema } from '../../../src/schemas/index.js';
import { initProjectTree } from '../../helpers/canonical-project.js';
import { scriptedBindings, scriptedOrdinaryAdmission } from '../../helpers/llm-test-helpers.js';
import { invocationProviderRegistry, contextExhausted } from '../../helpers/invocation-provider-fixture.js';
import { deterministicSummarySerialization } from '../../helpers/summary-serialization.js';
import { ACTIVITY_ROW_POLICY, TEXT_ROW_POLICY } from '../../helpers/row-policy-fixtures.js';

const CANDIDATE = { provider: 'test', account: null, model: 'test-model' } as const;
const roots: string[] = [];

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe('ConversationLLMActor last-chance summary publication ownership', () => {
  it('publishes summary and triggering attempts once under separate identities and rejects with the fieldless ownership marker', async () => {
    const fixture = actorFixture();
    const summaryFailure = providerFailure('summary-input', 'server_transient');
    const summarySessionId = internalCompactionSummarySessionId(fixture.input.sessionId);
    fixture.compact.mockImplementation(async ({ summarizerProvider }) => {
      summarizerProvider.projectProviderExchanges(summarySessionId, 'summary-input', summaryFailure.provider_exchanges, { assistantOutputIds: [], terminalConversationOutputId: null });
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
    expect(fixture.summaryProjection).toHaveBeenCalledWith(summarySessionId, 'summary-input', expect.any(Array), { assistantOutputIds: [], terminalConversationOutputId: null });
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
    const fixture = actorFixture(invocation(), publicationFailure);
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
  it('carries a real marker-led P1 through strict authoritative freshness and ordinary no-smaller settlement', async () => {
    const root = mkdtempSync(join(tmpdir(), 'saivage-real-actor-compaction-'));
    roots.push(root);
    initProjectTree(root);
    seedMarkerLedRounds(root);
    const cardBlock = Object.freeze({ id: 'card-activation:project', role: 'system' as const, content: '{"card":"frozen"}', storage: 'activation_local' as const, replacement: { kind: 'retain' as const }, audience: 'primary_and_summarizer' as const, evidence: { kind: 'none' as const } });
    const nodeBlock = Object.freeze({ id: 'node-activation:project:work', role: 'system' as const, content: "Current workflow node 'work':\n\nFROZEN-COMPILED-NODE", storage: 'activation_local' as const, replacement: { kind: 'retain' as const }, audience: 'primary_and_summarizer' as const, evidence: { kind: 'none' as const } });
    const input = realCompactionInvocation(root, [cardBlock, nodeBlock]);
    expect(readCurrentConversationSegment(root, input.sessionId)!.entry.version).toBe(1);
    expect(shouldCompact(input)).toBe(false);
    const candidate = input.routePass.kind === 'ordinary' ? input.routePass.candidateChain[0]! : CANDIDATE;
    const service = new InvocationService({ projectRoot: root, freshness: NO_FRESHNESS_EFFECTS, registry: invocationProviderRegistry([candidate], { [candidate.provider]: { contextWindowTokens: 3_000, maxOutputTokens: 500 } }), candidateAvailability: new MemoryCandidateAvailability() });
    const productionProvider = createInvocationServiceProvider(service);
    const admissionInputs: PreparedLlmInvocationInput[] = [];
    const admissionKinds: string[] = [];
    const admissions: ReturnType<LLMProviderPort['preparePrimaryRequestAdmission']>[] = [];
    const provider: LLMProviderPort = {
      ...productionProvider,
      preparePrimaryRequestAdmission(value, signal) {
        admissionInputs.push(value);
        const admission = productionProvider.preparePrimaryRequestAdmission(value, signal);
        admissions.push(admission);
        admissionKinds.push(admission.kind);
        return admission;
      },
    };
    const strategies: string[] = [];
    const compactionInputs: PreparedLlmInvocationInput[] = [];
    const compactionSummaryCounts: number[] = [];
    const compactionSummaryProjectionCounts: number[] = [];
    const compactor: CompactorPort = {
      shouldCompact,
      compact: async (args) => {
        strategies.push(args.strategy);
        compactionInputs.push(args.input);
        const result = await compact(args);
        compactionSummaryCounts.push(summaryCompletion.mock.calls.length);
        compactionSummaryProjectionCounts.push(summaryProjection.mock.calls.length);
        return result;
      },
    };
    const summaryCompletion = jest.fn(async () => ({ result: { kind: 'message' as const, content: 'stable canonical summary '.repeat(8).trim() }, provider_exchanges: [] }));
    const summaryProjection = jest.fn();
    const sentBodies: string[] = [];
    jest.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      sentBodies.push(String(init?.body));
      return contextExhausted();
    });
    const terminal = jest.fn<LlmTerminalHandoff>();
    const actor = new ConversationLLMActor({ purpose: { kind: 'autonomous-card', cardId: 'project' }, gate: new RuntimeGate(), agentId: input.sessionId, provider, conversations: { projectRoot: root }, compactor, summarizerProvider: { candidate: CANDIDATE, contextWindowTokens: 100_000, maxOutputTokens: 10_000, serializeSummaryRequest: deterministicSummarySerialization, completeTurn: summaryCompletion, projectProviderExchanges: summaryProjection }, fatalPort: { publicationOutcomeUnknown(error): never { throw error; } } });

    const outcome = await actor.turn(input, undefined, terminal);

    expect(outcome).toMatchObject({ type: 'error', error: expect.stringContaining('no strictly smaller') });
    expect(admissionKinds).toEqual(['local_compaction_required', 'admitted']);
    expect(admissionInputs).toHaveLength(2);
    const p1 = admissionInputs[1]!;
    expect(p1).not.toBe(input);
    expect(p1.providerConversation).not.toEqual(input.providerConversation);
    expect(p1).toEqual({ ...input, providerConversation: p1.providerConversation });
    expect(p1.preparedContext.dynamicBlocks).toEqual([cardBlock, nodeBlock]);
    expect(p1.preparedContext.dynamicBlocks[0]).toBe(cardBlock);
    expect(p1.preparedContext.dynamicBlocks[1]).toBe(nodeBlock);
    expect(p1.preparedContext.dynamicBlocksSha256).toBe(input.preparedContext.dynamicBlocksSha256);
    expect(strategies).toEqual(['local_exact_admission', 'authoritative_context_recovery']);
    expect(compactionInputs[0]).toBe(input);
    expect(compactionInputs[1]).toBe(p1);
    expect(compactionInputs[1]!.providerConversation).toBe(p1.providerConversation);
    expect(readCurrentConversationSegment(root, input.sessionId)!.entry.version).toBe(2);
    expect(sentBodies).toHaveLength(1);
    if (admissions[1]!.kind !== 'admitted') throw new Error('Expected P1 admission.');
    const admittedCandidate = admissions[1]!.candidates.find((entry) => entry.kind === 'admitted');
    if (!admittedCandidate || admittedCandidate.kind !== 'admitted') throw new Error('Expected an admitted P1 candidate.');
    expect(sentBodies[0]).toBe(admittedCandidate.plan.request.serializedBody);
    expect(sentBodies[0]).toContain('stable canonical summary');
    expect(sentBodies[0]).toContain('frozen');
    expect(sentBodies[0]).not.toContain('P0-CONTENT-');
    expect(compactionSummaryCounts[0]).toBeGreaterThan(0);
    expect(compactionSummaryCounts[1]).toBe(compactionSummaryCounts[0]);
    expect(compactionSummaryProjectionCounts[0]).toBeGreaterThan(0);
    expect(compactionSummaryProjectionCounts[1]).toBe(compactionSummaryProjectionCounts[0]);
    expect(terminal).toHaveBeenCalledTimes(1);
    expect(terminal.mock.calls[0]![0].input).toBe(p1);
    expect(readConversation(root, input.sessionId).sourceRows.filter((row) => row.kind === 'model_issue')).toHaveLength(1);
    const providerRows = readFileSync(appLogFile(root), 'utf8').trim().split('\n').flatMap((line) => (JSON.parse(line) as { rows: Array<{ type: string; data: { source_input_id?: string } }> }).rows).filter((row) => row.type === 'provider_exchange' && row.data.source_input_id === input.inputId);
    expect(providerRows).toHaveLength(1);
  });

  it('invokes one local_exact_admission compaction before turn-start and sends only the re-admitted projection', async () => {
    const fixture = actorFixture();
    const compactedProjection = distinctProjection(fixture.input, 'local-p1');
    fixture.compact.mockResolvedValue({ kind: 'compacted', providerConversation: compactedProjection, estimatedProviderMessageTokens: 1 });
    fixture.prepare.mockReturnValueOnce(rejectedCompactionAdmission()).mockReturnValueOnce(scriptedOrdinaryAdmission());
    fixture.execute.mockImplementation(async () => ({ result: { kind: 'message' as const, content: 'post-compaction answer' }, provider_exchanges: [attempt(fixture.input.inputId, 'ok', 0)] }));
    const terminal = jest.fn<LlmTerminalHandoff>();
    const outcome = await fixture.actor.turn(fixture.input, undefined, terminal);
    expect(outcome.type).toBe('result');
    expect(fixture.compact).toHaveBeenCalledTimes(1);
    expect(fixture.compact.mock.calls[0]![0]).toMatchObject({ strategy: 'local_exact_admission' });
    expect(fixture.compact.mock.calls[0]![0].input).toBe(fixture.input);
    expect(fixture.prepare).toHaveBeenCalledTimes(2);
    expect(fixture.prepare.mock.calls[1]![0].providerConversation).toBe(compactedProjection);
    expect(fixture.prepare.mock.calls[1]![0].systemPrompt).toBe(fixture.input.systemPrompt);
    expect(fixture.prepare.mock.calls[1]![0].preparedCompaction).toBe(fixture.input.preparedCompaction);
    expect(fixture.execute).toHaveBeenCalledTimes(1);
    expect(terminal.mock.calls[0]![0].input.providerConversation).toBe(compactedProjection);
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

  it('adds only the fixed construction diagnostic to local exact-admission failure', async () => {
    const fixture = actorFixture();
    fixture.prepare.mockReturnValueOnce(rejectedCompactionAdmission());
    const construction = new CompactionSummaryConstructionError({ reason: 'fold_limit', invocationCount: 16, correctionCount: 1, cause: new Error('SENTINEL RAW CAUSE') });
    fixture.compact.mockRejectedValue(construction);
    const failure = await fixture.actor.turn(fixture.input, undefined, jest.fn()).catch((error: unknown) => error);
    expect(failure).toMatchObject({ name: 'LocalExactAdmissionError', cause: construction });
    expect((failure as Error).message).toContain('reason=fold_limit');
    expect((failure as Error).message).not.toContain('SENTINEL');
    expect(fixture.execute).not.toHaveBeenCalled();
  });
});

describe('ConversationLLMActor authoritative admitted recovery', () => {
  it('formats owned construction diagnostics without exposing the internal cause and keeps provider exhaustion on the separate handoff', async () => {
    const fixture = actorFixture();
    const construction = new CompactionSummaryConstructionError({ reason: 'incomplete_output', invocationCount: 2, correctionCount: 1, summaryBytes: 9_999, summaryTargetBytes: 12_000, cause: new Error('SENTINEL INTERNAL CAUSE') });
    fixture.compact.mockRejectedValue(construction);
    const outcome = await fixture.actor.turn(fixture.input, undefined, jest.fn());
    expect(outcome).toMatchObject({ type: 'error', error: expect.stringContaining('reason=incomplete_output') });
    if (outcome.type !== 'error') throw new Error('Expected construction failure outcome.');
    expect(outcome.error).toContain('invocation_count=2');
    expect(outcome.error).toContain('correction_count=1');
    expect(outcome.error).not.toContain('SENTINEL');
    expect(fixture.plannerProjection).toHaveBeenCalledTimes(1);
  });

  it('holds the suspension untouched, compacts authoritatively once, and returns the same suspension to recovery preparation', async () => {
    const fixture = actorFixture();
    const compactedProjection = distinctProjection(fixture.input, 'authoritative-p2');
    const compacted = { kind: 'compacted' as const, providerConversation: compactedProjection, estimatedProviderMessageTokens: 1 };
    fixture.compact.mockResolvedValue(compacted);
    const resumeCompletion = { result: { kind: 'message' as const, content: 'recovered' }, provider_exchanges: [attempt(fixture.input.inputId, 'error', 0), attempt(fixture.input.inputId, 'ok', 1)] };
    fixture.prepareRecovery.mockReturnValue({ kind: 'recovery_prepared' } as never);
    fixture.resume.mockResolvedValue(resumeCompletion);
    const terminal = jest.fn<LlmTerminalHandoff>();
    const outcome = await fixture.actor.turn(fixture.input, undefined, terminal);
    expect(outcome).toMatchObject({ type: 'result', result: { content: 'recovered' } });
    expect(fixture.compact).toHaveBeenCalledTimes(1);
    expect(fixture.compact.mock.calls[0]![0]).toMatchObject({ strategy: 'authoritative_context_recovery' });
    expect(fixture.prepareRecovery).toHaveBeenCalledTimes(1);
    const recoveryArgs = fixture.prepareRecovery.mock.calls[0]![0];
    expect(recoveryArgs.suspension).toBe(fixture.capturedSuspension);
    expect(recoveryArgs.input.providerConversation).toBe(compactedProjection);
    expect(recoveryArgs.input).toEqual({ ...fixture.input, providerConversation: compactedProjection });
    expect(recoveryArgs.input.preparedCompaction).toBe(fixture.input.preparedCompaction);
    expect(fixture.resume).toHaveBeenCalledTimes(1);
    expect(terminal.mock.calls[0]![0].input).toBe(recoveryArgs.input);
    expect(fixture.pinnedPreflight).not.toHaveBeenCalled();
  });

  it('settles a recovery preparation terminal failure as an ordinary error outcome without retry transport', async () => {
    const fixture = actorFixture();
    const compactedProjection = distinctProjection(fixture.input, 'terminal-p2');
    fixture.compact.mockResolvedValue({ kind: 'compacted', providerConversation: compactedProjection, estimatedProviderMessageTokens: 1 });
    const terminal = providerFailure(fixture.input.inputId, 'input_context_exhausted');
    fixture.prepareRecovery.mockImplementation(() => { throw terminal; });
    const terminalHandoff = jest.fn<LlmTerminalHandoff>();
    const outcome = await fixture.actor.turn(fixture.input, undefined, terminalHandoff);
    expect(outcome).toMatchObject({ type: 'error', error: 'input_context_exhausted' });
    const recoveryInput = fixture.prepareRecovery.mock.calls[0]![0].input;
    expect(recoveryInput.providerConversation).toBe(compactedProjection);
    expect(terminalHandoff.mock.calls[0]![0].input).toBe(recoveryInput);
    expect(fixture.resume).not.toHaveBeenCalled();
  });

  it('settles clean no-smaller as one ordinary terminal-linked model issue without summary activity', async () => {
    const fixture = actorFixture();
    const before = readCurrentConversationSegment(fixture.root, fixture.input.sessionId);
    fixture.compact.mockResolvedValue({ kind: 'no_smaller_projection', rejectedEstimatedProviderMessageTokens: 10, smallestCandidateEstimatedProviderMessageTokens: null });
    const terminal = jest.fn<LlmTerminalHandoff>();

    const outcome = await fixture.actor.turn(fixture.input, undefined, terminal);

    expect(outcome).toMatchObject({ type: 'error', error: expect.stringContaining('no strictly smaller') });
    expect(fixture.compact).toHaveBeenCalledTimes(1);
    expect(fixture.compact.mock.calls[0]![0].strategy).toBe('authoritative_context_recovery');
    expect(fixture.serializeSummaryRequest).not.toHaveBeenCalled();
    expect(fixture.summaryCompletion).not.toHaveBeenCalled();
    expect(fixture.summaryProjection).not.toHaveBeenCalled();
    expect(fixture.prepareRecovery).not.toHaveBeenCalled();
    expect(fixture.resume).not.toHaveBeenCalled();
    expect(terminal).toHaveBeenCalledTimes(1);
    expect(terminal.mock.calls[0]![0].input).toBe(fixture.input);
    const after = readCurrentConversationSegment(fixture.root, fixture.input.sessionId)!;
    expect(before).toBeNull();
    expect(after.entry.version).toBe(1);
    const issues = after.conversation.sourceRows.filter((row) => row.kind === 'model_issue');
    expect(issues).toHaveLength(1);
    expect(fixture.plannerProjection).toHaveBeenCalledTimes(1);
    expect(fixture.plannerProjection).toHaveBeenCalledWith(
      fixture.input.sessionId,
      fixture.input.inputId,
      fixture.firstFailure.provider_exchanges,
      { assistantOutputIds: [], terminalConversationOutputId: issues[0]!.id },
    );
    fixture.actor.suppressContinuation(new Error('test join'));
    await expect(fixture.actor.join()).resolves.toEqual({ status: 'joined' });
  });

  it('parks a recovered tool call with the exact P2 prepared input and provider-owned attempts', async () => {
    const fixture = actorFixture(withTool(invocation()));
    const compactedProjection = distinctProjection(fixture.input, 'parked-p2');
    fixture.compact.mockResolvedValue({ kind: 'compacted', providerConversation: compactedProjection, estimatedProviderMessageTokens: 1 });
    fixture.prepareRecovery.mockReturnValue({ kind: 'recovery_prepared' } as never);
    const attempts = [attempt(fixture.input.inputId, 'error', 0), attempt(fixture.input.inputId, 'ok', 1)];
    fixture.resume.mockResolvedValue({ result: { kind: 'tool_calls', tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'lookup', arguments: '{"query":"x"}' } }] }, provider_exchanges: attempts });
    const terminal = jest.fn<LlmTerminalHandoff>();

    const outcome = await fixture.actor.turn(fixture.input, undefined, terminal);

    expect(outcome.type).toBe('tool_call');
    if (outcome.type !== 'tool_call') throw new Error('Expected tool call.');
    const capturedRecoveryInput = fixture.prepareRecovery.mock.calls[0]![0].input;
    expect(fixture.actor.waitingToolInput(outcome)).toBe(capturedRecoveryInput);
    expect(fixture.actor.waitingToolInput(outcome).providerConversation).toBe(compactedProjection);
    expect(fixture.prepareRecovery).toHaveBeenCalledTimes(1);
    expect(fixture.prepareRecovery.mock.calls[0]![0].suspension).toBe(fixture.capturedSuspension);
    expect(fixture.resume).toHaveBeenCalledTimes(1);
    expect(terminal).not.toHaveBeenCalled();
    expect(fixture.plannerProjection).toHaveBeenCalledTimes(1);
    expect(fixture.plannerProjection.mock.calls[0]![2]).toEqual(attempts);
    expect(fixture.plannerProjection.mock.calls[0]![2].map((entry: ProviderExchangeAttempt) => [entry.source_input_id, entry.attempt_index])).toEqual([[fixture.input.inputId, 0], [fixture.input.inputId, 1]]);
    expect(readConversation(fixture.root, fixture.input.sessionId).sourceRows.filter((row) => row.kind === 'tool_call')).toHaveLength(1);
  });

  it.each(['resolved', 'rejected'] as const)('propagates an exact ProviderTurnFailure abort reason from a %s compactor without summary classification', async (mode) => {
    const fixture = actorFixture();
    const controller = new AbortController();
    const reason = providerFailure(fixture.input.inputId, 'server_transient');
    fixture.compact.mockImplementation(async () => {
      controller.abort(reason);
      if (mode === 'rejected') throw reason;
      return { kind: 'no_smaller_projection', rejectedEstimatedProviderMessageTokens: 10, smallestCandidateEstimatedProviderMessageTokens: null };
    });
    const terminal = jest.fn<LlmTerminalHandoff>();

    await expect(fixture.actor.turn(fixture.input, controller.signal, terminal)).rejects.toBe(reason);
    expect(fixture.plannerProjection).not.toHaveBeenCalled();
    expect(fixture.summaryProjection).not.toHaveBeenCalled();
    expect(fixture.prepareRecovery).not.toHaveBeenCalled();
    expect(fixture.resume).not.toHaveBeenCalled();
    expect(terminal).not.toHaveBeenCalled();
    expect(readConversation(fixture.root, fixture.input.sessionId).sourceRows.some((row) => row.kind === 'model_issue')).toBe(false);
  });

  it('delivers publication uncertainty to fatal ownership before classifying a simultaneous abort', async () => {
    const fixture = actorFixture();
    const controller = new AbortController();
    const reason = providerFailure(fixture.input.inputId, 'server_transient');
    const failure = new PublicationOutcomeUnknownError();
    fixture.compact.mockImplementation(async () => { controller.abort(reason); throw failure; });
    const terminal = jest.fn<LlmTerminalHandoff>();

    await expect(fixture.actor.turn(fixture.input, controller.signal, terminal)).rejects.toBe(reason);
    fixture.actor.suppressContinuation(new Error('test join'));
    await expect(fixture.actor.join()).resolves.toEqual({ status: 'joined' });
    expect(fixture.publicationOutcomeUnknown).toHaveBeenCalledWith(failure);
    expect(fixture.plannerProjection).not.toHaveBeenCalled();
    expect(fixture.summaryProjection).not.toHaveBeenCalled();
    expect(fixture.prepareRecovery).not.toHaveBeenCalled();
    expect(terminal).not.toHaveBeenCalled();
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

function distinctProjection(input: PreparedLlmInvocationInput, identity: string): PreparedLlmInvocationInput['providerConversation'] {
  return { sourceSessionId: input.sessionId, messages: [{ kind: 'synthetic_context', origin: 'dynamic', block_identity: identity, role: 'system', content: identity }] };
}

function rejectedCompactionAdmission() {
  return { kind: 'local_compaction_required' as const, routePass: { kind: 'ordinary' as const, candidateChain: [CANDIDATE] }, candidates: [], bindings: scriptedBindings() };
}

function actorFixture(inputOverride: PreparedLlmInvocationInput = invocation(), plannerPublicationFailure?: Error) {
  const root = mkdtempSync(join(tmpdir(), 'saivage-last-chance-summary-'));
  roots.push(root);
  initProjectTree(root);
  const input = inputOverride;
  const firstFailure = providerFailure(input.inputId, 'input_context_exhausted');
  const plannerProjection = jest.fn<NonNullable<LLMProviderPort['projectProviderExchanges']>>(() => {
    if (plannerPublicationFailure) throw plannerPublicationFailure;
  });
  const summaryProjection = jest.fn();
  const serializeSummaryRequest = jest.fn(() => { throw new Error('unexpected summary provider serialization'); });
  const summaryCompletion = jest.fn(async () => { throw new Error('unexpected summary provider call'); });
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
    summarizerProvider: { candidate: CANDIDATE, contextWindowTokens: 100_000, maxOutputTokens: 10_000, serializeSummaryRequest, completeTurn: summaryCompletion, projectProviderExchanges: summaryProjection },
    fatalPort: { publicationOutcomeUnknown: publicationOutcomeUnknown as unknown as (error: PublicationOutcomeUnknownError) => never },
  });
  return { root, input, actor, compact, prepare, execute, prepareRecovery, resume, pinnedPreflight, plannerProjection, summaryProjection, serializeSummaryRequest, summaryCompletion, publicationOutcomeUnknown, capturedSuspension, firstFailure };
}

function withTool(input: PreparedLlmInvocationInput): PreparedLlmInvocationInput {
  const contract = compileInvocationToolContract({ type: 'function', function: { name: 'lookup', description: 'Lookup', parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'], additionalProperties: false } } }, OBSERVATIONAL_READ_RESULT_POLICY_TEMPLATE);
  return {
    ...input,
    tools: [contract.providerDefinition],
    compiledToolContracts: [contract],
    preparedContext: buildPreparedInvocationContext({ instructionText: input.systemPrompt, terminalToolNames: [], compiledTools: [contract], dynamicBlocks: [], preparedCompaction: input.preparedCompaction! }),
    capabilityRequest: { requiresTools: true },
  };
}

function seedMarkerLedRounds(root: string): void {
  for (let ordinal = 1; ordinal <= 6; ordinal++) {
    const timestamp = `2026-09-09T00:0${ordinal}:00.000Z`;
    const inputId = ordinal === 6 ? '00000000-0000-4000-8000-000000000001' : `00000000-0000-4000-8000-${String(ordinal + 1).padStart(12, '0')}`;
    appendConversationBatch({ projectRoot: root }, [
      agentMessageSchema.parse({ id: `real-activation-${ordinal}`, session_id: 'agent:planner:project', role: 'system', kind: 'activity', context_policy: ACTIVITY_ROW_POLICY, content: JSON.stringify({ event: 'activation_open', agent_name: 'planner', card_id: 'project', input_id: inputId, timestamp }), round_id: `r-pre-${String(ordinal).padStart(32, '0')}`, message_index: 0, block_index: 0, timestamp }),
      agentMessageSchema.parse({ id: `real-message-${ordinal}`, session_id: 'agent:planner:project', role: 'user', kind: 'text', context_policy: TEXT_ROW_POLICY, content: `P0-CONTENT-${ordinal}-`.repeat(350), round_id: `r-user-${String(ordinal).padStart(32, '0')}`, message_index: 1, block_index: 0, timestamp }),
    ]);
  }
}

function realCompactionInvocation(root: string, dynamicBlocks: Parameters<typeof buildPreparedInvocationContext>[0]['dynamicBlocks']): PreparedLlmInvocationInput {
  const preparedCompaction = prepareCompaction({ context_utilization_fraction: 0.8, trigger_fraction: 0.8, tail_fraction: 0.01, snap: 'compact_straddler' }, 'system', [], 80_000, 500);
  const preparedContext = buildPreparedInvocationContext({ instructionText: 'system', terminalToolNames: [], compiledTools: [], dynamicBlocks, preparedCompaction });
  return {
    inputId: '00000000-0000-4000-8000-000000000001', agentId: 'agent:planner:project', agentName: 'planner', sessionId: 'agent:planner:project', systemPrompt: 'system',
    providerConversation: providerConversationProjection(readConversation(root, 'agent:planner:project'), preparedContext.dynamicBlocks),
    tools: [], compiledToolContracts: [], terminalToolNames: [], modelParams: { temperature: 0 }, preparedCompaction, preparedContext, capabilityRequest: {},
    routePass: { kind: 'ordinary', candidateChain: [{ provider: 'real-fixture', account: null, model: 'real-model' }] }, episodeContext: {},
  };
}

function invocation(): PreparedLlmInvocationInput {
  const sessionId = 'agent:planner:project' as const;
  const preparedCompaction = prepareCompaction({ context_utilization_fraction: 0.8, trigger_fraction: 0.8, tail_fraction: 0.25, snap: 'compact_straddler' }, 'system', [], 8_000, 2_000);
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
