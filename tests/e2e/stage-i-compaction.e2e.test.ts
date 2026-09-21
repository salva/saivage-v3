import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, jest } from '@jest/globals';

import { compact, prepareCompaction, shouldCompact, type AutonomousCompactionPolicy } from '../../src/runtime/actors/compaction/compactor.js';
import { validateConversation } from '../../src/contracts/conversation-validation.js';
import { estimateMessageTokens } from '../../src/runtime/actors/compaction/round-classifier.js';
import { classifyConversationRounds } from '../../src/runtime/actors/compaction/round-classifier.js';
import { estimateUtf8Tokens } from '../../src/runtime/actors/compaction/token-estimator.js';
import { appendConversationBatch, readConversation, readCurrentConversationSegment, readHistoricalConversationSegment } from '../../src/persistence/conversation-file.js';
import { providerConversationProjection } from '../../src/runtime/actors/conversation-session.js';
import type { ProviderConversationItem } from '../../src/agents/llm-contracts.js';
import { agentMessageSchema, conversationSessionIdentity, STRUCTURAL_ROW_POLICY, type AgentMessage, type ConversationSessionId } from '../../src/schemas/index.js';
import type { PreparedLlmInvocationInput } from '../../src/runtime/actors/llm-invocation.js';
import { buildPreparedInvocationContext } from '../../src/runtime/actors/context/context-blocks.js';
import { initProjectTree } from '../helpers/canonical-project.js';
import { deterministicSummarySerialization } from '../helpers/summary-serialization.js';
import { noCompactionProgress } from '../helpers/executing-llm-snapshot.js';
import { ACTIVITY_ROW_POLICY, TEXT_ROW_POLICY } from '../helpers/row-policy-fixtures.js';
import { cardConversationVersionIndexFile } from '../../src/persistence/layout.js';
import { buildCandidateRequest } from '../../src/agents/candidate-request.js';
import { selectLlmProtocolAdapter } from '../../src/agents/llm-protocol-adapter.js';
import { InvocationService } from '../../src/agents/invocation-service.js';
import { MemoryCandidateAvailability } from '../../src/agents/candidate-availability.js';
import { NO_FRESHNESS_EFFECTS } from '../../src/application/freshness-effects.js';
import type { ContextBlock } from '../../src/runtime/actors/context/context-blocks.js';
import type { ToolDefinition } from '../../src/agents/llm-contracts.js';
import { ProviderRegistry } from '../../src/agents/provider.js';
import { ModelRouter } from '../../src/agents/model-router.js';
import { bindRuntimeWorkflows, compileProjectWorkflows, runtimeAgentBinding } from '../../src/runtime/card-process/card-process-config.js';
import { TEST_SAIVAGE_CONFIG } from '../helpers/test-saivage-config.js';
import { toolRowPolicies } from '../helpers/row-policy-fixtures.js';
import { executeInternalSummaryTurn } from '../../src/application/invocation-service-provider.js';
import type { SummaryRequestSerialization, SummarizerProviderPort } from '../../src/runtime/actors/compaction/summarizer.js';
import type { Candidate } from '../../src/contracts/provider-candidate.js';

const config: AutonomousCompactionPolicy = { context_utilization_fraction: 0.8, trigger_fraction: 0.8, tail_fraction: 0.25, snap: 'compact_straddler' };
const TEST_CANDIDATE = { provider: 'test', account: null, model: 'test-model' } as const;

describe('Stage-I versioned compaction', () => {
  it('derives prepared route capacity and the configured tail budget', () => {
    const prepared = prepareCompaction(config, 'system', [], 8_000, 2_000); expect(prepared.requestedCompletionTokens).toBe(2000);
    const messages: AgentMessage[] = [{ id: 'm', session_id: 'agent:planner:project', role: 'user', kind: 'text', content: 'x'.repeat(4000), context_policy: TEXT_ROW_POLICY, round_id: `r-user-${'0'.repeat(32)}`, message_index: 0, block_index: 0, timestamp: '2026-08-11T00:00:00.000Z' }];
    expect(shouldCompact(invocationFor('agent:planner:project', messages))).toBe(messages.reduce((sum, row) => sum + estimateMessageTokens(row), 0) >= prepared.triggerMessageThreshold);
    expect(prepared.tailBudgetTokens).toBe(2000);
  });

  it('publishes a compacted segment head while preserving v1 as explicit history', async () => {
    const root = mkdtempSync(join(tmpdir(), 'saivage-versioned-compaction-')); initProjectTree(root);
    try {
      for (let ordinal = 1; ordinal <= 7; ordinal++) appendRound(root, ordinal);
      const before = readConversation(root, SESSION); const result = await compact({ strategy: 'preventive', conversations: { projectRoot: root }, input: invocationFor(SESSION, providerConversationProjection(before, []).messages), summarizerProvider: { candidate: TEST_CANDIDATE, contextWindowTokens: 100_000, maxOutputTokens: 10_000, serializeSummaryRequest: deterministicSummarySerialization, completeTurn: async () => ({ result: { kind: 'message' as const, content: 'summary' }, provider_exchanges: [] }), projectProviderExchanges: jest.fn() }, signal: new AbortController().signal, progress: noCompactionProgress });
      expect(result.kind).toBe('compacted'); const current = readCurrentConversationSegment(root, SESSION)!;
      expect(current.entry.version).toBe(2); expect(current.genesis.kind).toBe('compacted_segment_genesis'); expect(current.rows.some((row) => row.kind === ('context_compaction' as never))).toBe(false);
      expect(readHistoricalConversationSegment(root, SESSION, 1).genesis.kind).toBe('ordinary_segment_genesis');
      const durableSummaryText = current.conversation.effectiveCompactedHistory!.summaryText;
      expect(durableSummaryText).toBe('summary');
      const projection = providerConversationProjection(current.conversation, []);
      if (projection.sourceSessionId === null) throw new Error('missing compacted provider conversation source');
      const projected = projection.messages;
      const boundaries = projected.filter((row) => row.kind === 'synthetic_context' && row.origin === 'context_boundary');
      const historySummaries = projected.filter((row) => row.kind === 'synthetic_context' && row.origin === 'history_summary');
      expect(boundaries).toHaveLength(1);
      expect(boundaries[0]).toMatchObject({ kind: 'synthetic_context', role: 'system', origin: 'context_boundary' });
      expect(boundaries[0]!.content).not.toHaveLength(0);
      expect(historySummaries).toHaveLength(1);
      expect(historySummaries[0]).toMatchObject({ kind: 'synthetic_context', role: 'system', origin: 'history_summary' });
      expect(projected.indexOf(historySummaries[0]!)).toBe(projected.indexOf(boundaries[0]!) + 1);
      const summaryRequestPrefix = 'Historical summary:\n';
      expect(historySummaries[0]!.content.startsWith(summaryRequestPrefix)).toBe(true);
      expect(historySummaries[0]!.content.slice(summaryRequestPrefix.length)).toBe(durableSummaryText);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('retains configured instructions across two compactions and releases a replaced key only into the successor summary', async () => {
    const root = mkdtempSync(join(tmpdir(), 'saivage-protected-compaction-')); initProjectTree(root);
    const summaryInputs: string[] = [];
    const summarizerProvider: SummarizerProviderPort = { candidate: TEST_CANDIDATE, contextWindowTokens: 100_000, maxOutputTokens: 10_000, serializeSummaryRequest: deterministicSummarySerialization, completeTurn: async (input) => { summaryInputs.push(...input.providerConversation.messages.map(({ content }) => content)); return { result: { kind: 'message' as const, content: `summary-${summaryInputs.length}` }, provider_exchanges: [] }; }, projectProviderExchanges: jest.fn() };
    const originalFetch = globalThis.fetch;
    try {
      appendProtectedRound(root, 1, 'protected-old', 'EXACT OLD INSTRUCTION', 'workflow.rule');
      const coveredProcess = appendProcessSettlement(root, 1, 'covered-process', { stdout_complete: true, stderr_complete: false });
      for (let ordinal = 2; ordinal <= 7; ordinal++) appendRound(root, ordinal);
      const firstBefore = readConversation(root, SESSION);
      expect((await compact({ strategy: 'preventive', conversations: { projectRoot: root }, input: invocationFor(SESSION, providerConversationProjection(firstBefore, []).messages), summarizerProvider, signal: new AbortController().signal, progress: noCompactionProgress })).kind).toBe('compacted');
      const first = readCurrentConversationSegment(root, SESSION)!;
      expect(first.conversation.effectiveCompactedHistory!.protectedPrompts.map(({ message }) => message.id)).toEqual(['protected-old']);
      expect(providerConversationProjection(first.conversation, []).messages.filter(({ content }) => content === 'EXACT OLD INSTRUCTION')).toHaveLength(1);
      const coveredSummaryBodies = summaryInputs.filter((content) => content.includes(coveredProcess.process_id)).map(summaryWrappedBody);
      expect(coveredSummaryBodies).toContain(coveredProcess.content);
      expect(coveredSummaryBodies.join('')).toContain(coveredProcess.stdout_url);
      expect(coveredSummaryBodies.join('')).toContain(coveredProcess.stderr_url);

      appendProtectedRound(root, 8, 'protected-new', 'EXACT NEW INSTRUCTION', 'workflow.rule');
      for (let ordinal = 9; ordinal <= 14; ordinal++) appendRound(root, ordinal);
      const secondBefore = readConversation(root, SESSION);
      expect((await compact({ strategy: 'preventive', conversations: { projectRoot: root }, input: invocationFor(SESSION, providerConversationProjection(secondBefore, []).messages), summarizerProvider, signal: new AbortController().signal, progress: noCompactionProgress })).kind).toBe('compacted');
      const second = readCurrentConversationSegment(root, SESSION)!;
      expect(second.entry.version).toBe(3);
      expect(second.conversation.effectiveCompactedHistory!.protectedPrompts.map(({ message }) => message.id)).toEqual(['protected-new']);
      const uncoveredProcess = appendProcessSettlement(root, 14, 'uncovered-process', { stdout_complete: true, stderr_complete: false });
      const current = readConversation(root, SESSION);
      const projectedConversation = providerConversationProjection(current, []);
      const projected = projectedConversation.messages;
      expect(projected.filter(({ content }) => content === 'EXACT OLD INSTRUCTION')).toHaveLength(0);
      expect(projected.filter(({ content }) => content === 'EXACT NEW INSTRUCTION')).toHaveLength(1);
      expect(summaryInputs.filter((content) => content.includes('kind=released_protected_instruction') && content.includes('EXACT OLD INSTRUCTION'))).toHaveLength(1);
      expect(readHistoricalConversationSegment(root, SESSION, 2).conversation.effectiveCompactedHistory!.protectedPrompts.map(({ message }) => message.id)).toEqual(['protected-old']);
      expect(projected.some((message) => message.kind !== 'synthetic_context' && message.id === coveredProcess.resultId)).toBe(false);
      const retainedInstructionIndex = projected.findIndex((message) => message.kind === 'synthetic_context' && message.origin === 'retained_instruction' && message.content === 'EXACT NEW INSTRUCTION');
      const uncoveredResultIndex = projected.findIndex((message) => message.kind !== 'synthetic_context' && message.id === uncoveredProcess.resultId);
      expect(retainedInstructionIndex).toBeGreaterThanOrEqual(0);
      expect(uncoveredResultIndex).toBeGreaterThan(retainedInstructionIndex);
      const uncoveredProjected = projected[uncoveredResultIndex];
      if (!uncoveredProjected || uncoveredProjected.kind === 'synthetic_context') throw new Error('Missing uncovered process result.');
      const uncoveredData = (JSON.parse(uncoveredProjected.content) as { data: Record<string, unknown> }).data;
      expect(uncoveredData).not.toHaveProperty('stdout_url');
      expect(uncoveredData.stderr_url).toBe(uncoveredProcess.stderr_url);
      expect(uncoveredProjected.content).not.toContain(uncoveredProcess.stdout_url);
      expect(uncoveredProjected.content).toContain(uncoveredProcess.stderr_url);
      expect(current.physicalRows.find((row) => row.id === uncoveredProcess.resultId)?.content).toBe(uncoveredProcess.content);

      const registryConfig = structuredClone(TEST_SAIVAGE_CONFIG);
      registryConfig.providers.test = { ...registryConfig.providers.test!, apiKey: 'synthetic-test-key', baseUrl: 'https://process-projection.example.test/v1' };
      const registry = new ProviderRegistry(registryConfig);
      const service = invocationService(root, registry);
      const admission = service.preparePrimaryRequestAdmission(invocationFor(SESSION, projected));
      if (admission.kind !== 'admitted') throw new Error(`Post-compaction process request was ${admission.kind}.`);
      const verdict = admission.candidates[0];
      if (!verdict || verdict.kind !== 'admitted') throw new Error('Post-compaction process candidate was not admitted.');
      const admittedBody = verdict.plan.request.serializedBody;
      const admittedHash = verdict.plan.request.requestHash;
      expect(admittedBody).toContain(uncoveredProcess.stderr_url);
      expect(admittedBody).not.toContain(uncoveredProcess.stdout_url);
      expect(admittedBody).not.toContain(coveredProcess.stdout_url);
      let sentBody = '';
      globalThis.fetch = jest.fn(async (_url: string | URL | Request, init?: RequestInit) => {
        sentBody = String(init?.body);
        expect(sentBody).toBe(admittedBody);
        expect(createHash('sha256').update(sentBody, 'utf8').digest('hex')).toBe(admittedHash);
        return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'post-compaction admitted' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }), { status: 200, headers: { 'content-type': 'application/json' } });
      }) as typeof fetch;
      await expect(service.executeAdmittedWithRecovery(admission)).resolves.toMatchObject({ result: { kind: 'message', content: 'post-compaction admitted' } });
      expect(sentBody).toBe(admittedBody);
    } finally { globalThis.fetch = originalFetch; rmSync(root, { recursive: true, force: true }); }
  });

  it('walks multiple cutoffs with disjoint raw inputs, sequential calls, and one canonical selected successor', async () => {
    const root = mkdtempSync(join(tmpdir(), 'saivage-incremental-compaction-')); initProjectTree(root);
    try {
      for (let ordinal = 1; ordinal <= 7; ordinal++) appendRound(root, ordinal);
      const before = readConversation(root, SESSION);
      const rawRequests: string[][] = [];
      let activeCalls = 0;
      let maximumActiveCalls = 0;
      const result = await compact({
        strategy: 'local_exact_admission', conversations: { projectRoot: root }, input: invocationFor(SESSION, providerConversationProjection(before, []).messages),
        summarizerProvider: {
          candidate: TEST_CANDIDATE,
          contextWindowTokens: 100_000,
          maxOutputTokens: 10_000,
          serializeSummaryRequest: deterministicSummarySerialization,
          completeTurn: async (input) => {
            activeCalls++;
            maximumActiveCalls = Math.max(maximumActiveCalls, activeCalls);
            rawRequests.push(input.providerConversation.messages.map((row) => row.content));
            await Promise.resolve();
            activeCalls--;
            return { result: { kind: 'message' as const, content: 'summary' }, provider_exchanges: [] };
          },
          projectProviderExchanges: jest.fn(),
        }, signal: new AbortController().signal, progress: noCompactionProgress,
      });
      expect(result.kind).toBe('compacted');
      expect(maximumActiveCalls).toBe(1);
      const allInputs = rawRequests.flat();
      for (let ordinal = 1; ordinal <= 7; ordinal++)
        expect(allInputs.filter((content) => content.includes(`source=message-${ordinal}`))).toHaveLength(1);
      const current = readCurrentConversationSegment(root, SESSION)!;
      expect(current.entry.version).toBe(2);
      expect(current.rows).toEqual([]);
      expect(current.conversation.effectiveCompactedHistory!.coverageCommitment.coveredThroughMessageId).toBe('message-7');
      expect(readHistoricalConversationSegment(root, SESSION, 1).rows).toHaveLength(14);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('rejects an already-aborted persisted compaction before oversized summary work or canonical head changes', async () => {
    const root = mkdtempSync(join(tmpdir(), 'saivage-aborted-compaction-')); initProjectTree(root);
    try {
      appendRound(root, 1);
      const before = readCurrentConversationSegment(root, SESSION)!;
      const indexPath = cardConversationVersionIndexFile(root, 'project', 'planner');
      const beforeIndexBytes = readFileSync(indexPath);
      const reason = new Error('cancel persisted compaction before admission');
      const controller = new AbortController();
      controller.abort(reason);
      const serializeSummaryRequest = jest.fn((input: Parameters<typeof deterministicSummarySerialization>[0]) => ({
        ...deterministicSummarySerialization(input),
        estimatedInputTokens: 100_000,
      }));
      const completeTurn = jest.fn(async () => ({ result: { kind: 'message' as const, content: 'unexpected' }, provider_exchanges: [] }));
      const projectProviderExchanges = jest.fn();
      const foldStarted = jest.fn();
      const foldCompleted = jest.fn();

      await expect(compact({
        strategy: 'preventive',
        conversations: { projectRoot: root },
        input: invocationFor(SESSION, providerConversationProjection(before.conversation, []).messages),
        summarizerProvider: { candidate: TEST_CANDIDATE, contextWindowTokens: 100_000, maxOutputTokens: 10_000, serializeSummaryRequest, completeTurn, projectProviderExchanges },
        signal: controller.signal,
        progress: { foldStarted, foldCompleted, foldFailed: jest.fn() },
      })).rejects.toBe(reason);

      expect(serializeSummaryRequest).not.toHaveBeenCalled();
      expect(completeTurn).not.toHaveBeenCalled();
      expect(projectProviderExchanges).not.toHaveBeenCalled();
      expect(foldStarted).not.toHaveBeenCalled();
      expect(foldCompleted).not.toHaveBeenCalled();
      expect(readFileSync(indexPath)).toEqual(beforeIndexBytes);
      const after = readCurrentConversationSegment(root, SESSION)!;
      expect(after.index).toEqual(before.index);
      expect(after.entry).toEqual(before.entry);
      expect(after.genesis).toEqual(before.genesis);
      expect(after.rows).toEqual(before.rows);
      expect(after.bytes).toEqual(before.bytes);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('passes the realistic full-window model-aware production-composition gate within sixteen calls', async () => {
    const root = mkdtempSync(join(tmpdir(), 'saivage-full-window-compaction-'));
    const preventiveRoot = mkdtempSync(join(tmpdir(), 'saivage-full-window-preventive-'));
    initProjectTree(root);
    initProjectTree(preventiveRoot);
    const originalFetch = globalThis.fetch;
    try {
      const astra = { provider: 'astra-fixture', account: null, model: 'astra-root' } as const;
      const sol = { provider: 'sol-fixture', account: null, model: 'sol-summary' } as const;
      const policy: AutonomousCompactionPolicy = { context_utilization_fraction: 0.8, trigger_fraction: 0.9, tail_fraction: 0.25, snap: 'compact_straddler' };
      const systemPrompt = 'R'.repeat(8_636);
      const tools = auditSizedTools(23_657);
      expect(Buffer.byteLength(systemPrompt, 'utf8') + Buffer.byteLength(JSON.stringify(tools), 'utf8')).toBe(32_293);
      const dynamicBlocks: ContextBlock[] = [
        { id: 'card-activation:project', role: 'system', content: 'B'.repeat(11_708), storage: 'activation_local', replacement: { kind: 'retain' }, audience: 'primary_and_summarizer', evidence: { kind: 'none' } },
        { id: 'node-activation:project:plan', role: 'system', content: 'N'.repeat(3_292), storage: 'activation_local', replacement: { kind: 'retain' }, audience: 'primary_and_summarizer', evidence: { kind: 'none' } },
      ];
      const registryConfig = structuredClone(TEST_SAIVAGE_CONFIG);
      registryConfig.compaction = { ...registryConfig.compaction, ...policy, summarizer_candidate: sol };
      registryConfig.models.routes = Object.fromEntries(Object.entries(registryConfig.models.routes).map(([name, route]) => [name, { ...route, candidates: [astra.model], max_tokens: 4_096 }]));
      registryConfig.providers = {
        'astra-fixture': { models: [astra.model], apiKey: 'synthetic-astra-key', baseUrl: 'https://astra.example.test/v1', capabilities: { transportProtocol: 'openai-responses', toolsMode: 'native', exclusiveToolChoiceSupport: 'native', contextWindowTokens: 1_050_000, maxOutputTokens: 4_096 } },
        'sol-fixture': { models: [sol.model], apiKey: 'synthetic-sol-key', baseUrl: 'https://sol.example.test/v1', capabilities: { transportProtocol: 'openai-chat-completions', toolsMode: 'native', exclusiveToolChoiceSupport: 'native', contextWindowTokens: 120_000, maxOutputTokens: 8_192 } },
      };
      const registry = new ProviderRegistry(registryConfig);
      const workflows = bindRuntimeWorkflows(compileProjectWorkflows(registryConfig), new ModelRouter(registry), registry, policy.context_utilization_fraction);
      const plannerBinding = runtimeAgentBinding(workflows, 'planner');
      expect(plannerBinding.candidateChain).toEqual([astra]);
      expect(plannerBinding.routeUsableInputTokens).toBe(835_904);
      const preparedCompaction = prepareCompaction(policy, systemPrompt, tools, plannerBinding.routeUsableInputTokens, 4_096);

      const fixture = buildFullWindowFixture(preparedCompaction, dynamicBlocks);
      appendConversationBatch({ projectRoot: root }, fixture.rows);
      appendConversationBatch({ projectRoot: preventiveRoot }, fixture.rows);
      const before = readConversation(root, SESSION);
      const providerConversation = providerConversationProjection(before, dynamicBlocks);
      const actorTokens = actorProjectionTokens(providerConversation);
      expect(actorTokens).toBeGreaterThanOrEqual(preparedCompaction.triggerMessageThreshold);
      expect(actorTokens - preparedCompaction.triggerMessageThreshold).toBeLessThan(fixture.maximumOrdinaryBundleTokens);
      const rawSourceBytes = before.sourceRows.reduce((sum, row) => sum + Buffer.byteLength(row.content, 'utf8'), 0);
      expect(rawSourceBytes).toBeGreaterThanOrEqual(2_900_000);
      expect(rawSourceBytes).toBeLessThanOrEqual(3_200_000);
      expect(fixture.expectedComponents.length).toBeGreaterThan(200);
      expect(classifyConversationRounds(before).rounds.at(-1)?.state).toBe('open');
      const endpoints = safeEndpoints(before, preparedCompaction.tailBudgetTokens);
      expect(endpoints).toHaveLength(2);
      expect(endpoints[0]).toBeLessThan(endpoints[1]!);
      expect(before.sourceRows[endpoints[1]! - 1]!.id).toBe(fixture.lastSettledResultId);
      expect(before.sourceRows.slice(endpoints[1]!).map((row) => row.id)).toEqual(fixture.unsettledPairIds);

      const inputFor = (conversation: typeof before): PreparedLlmInvocationInput => ({
        inputId: '10000000-0000-4000-8000-000000000001', agentId: SESSION, agentName: 'planner', sessionId: SESSION,
        systemPrompt, providerConversation: providerConversationProjection(conversation, dynamicBlocks), tools, compiledToolContracts: [], terminalToolNames: [], modelParams: { temperature: 0 },
        preparedCompaction,
        preparedContext: buildPreparedInvocationContext({ instructionText: systemPrompt, terminalToolNames: [], compiledTools: [], dynamicBlocks, preparedCompaction }),
        capabilityRequest: { requiresTools: true }, routePass: { kind: 'ordinary', candidateChain: [...plannerBinding.candidateChain] }, episodeContext: {},
      });
      const input = inputFor(before);
      expect(shouldCompact(input)).toBe(true);

      const transportSends: Array<{ model: string; body: string; expectedBody: string; expectedHash: string }> = [];
      let queued: { model: string; body: string; hash: string; response: string } | null = null;
      globalThis.fetch = jest.fn(async (_url: string | URL | Request, init?: RequestInit) => {
        if (!queued) throw new Error('Unexpected fake transport request.');
        const body = String(init?.body);
        const expected = queued;
        queued = null;
        expect(body).toBe(expected.body);
        expect(createHash('sha256').update(body, 'utf8').digest('hex')).toBe(expected.hash);
        const parsed = JSON.parse(body) as { model: string };
        expect(parsed.model).toBe(expected.model);
        transportSends.push({ model: parsed.model, body, expectedBody: expected.body, expectedHash: expected.hash });
        return expected.model === astra.model
          ? new Response(JSON.stringify({ status: 'completed', output: [{ type: 'message', id: 'primary-message', content: [{ type: 'output_text', text: expected.response }] }], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } }), { status: 200, headers: { 'content-type': 'application/json' } })
          : new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: expected.response }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }), { status: 200, headers: { 'content-type': 'application/json' } });
      }) as typeof fetch;

      const primaryService = invocationService(root, registry);
      const primaryAdmission = primaryService.preparePrimaryRequestAdmission(input);
      if (primaryAdmission.kind !== 'admitted') throw new Error(`Full-window primary admission was ${primaryAdmission.kind}: ${JSON.stringify(primaryAdmission.candidates)}`);
      const primaryVerdict = primaryAdmission.candidates[0];
      if (!primaryVerdict || primaryVerdict.kind !== 'admitted') throw new Error('Astra primary request was not admitted.');
      expect(primaryVerdict.plan.request.estimatedWireInputTokens).toBeLessThanOrEqual(plannerBinding.routeUsableInputTokens);
      queued = { model: astra.model, body: primaryVerdict.plan.request.serializedBody, hash: primaryVerdict.plan.request.requestHash, response: 'primary transport identity verified' };
      await expect(primaryService.executeAdmittedWithRecovery(primaryAdmission)).resolves.toMatchObject({ result: { kind: 'message', content: 'primary transport identity verified' } });
      expect(queued).toBeNull();

      const preventiveRecords: SummaryWireRecord[] = [];
      const preventiveProvider = summaryProvider({ root: preventiveRoot, registry, candidate: sol, records: preventiveRecords, setTransport: (next) => { queued = next; }, correctionOnFirstNormal: false });
      const preventiveResult = await compact({ strategy: 'preventive', conversations: { projectRoot: preventiveRoot }, input: inputFor(readConversation(preventiveRoot, SESSION)), summarizerProvider: preventiveProvider, signal: new AbortController().signal, progress: noCompactionProgress });
      expect(preventiveResult.kind).toBe('compacted');
      expect(readCurrentConversationSegment(preventiveRoot, SESSION)!.conversation.effectiveCompactedHistory!.coverageCommitment.coveredThroughMessageId).toBe(before.sourceRows[endpoints[0]! - 1]!.id);
      expect(preventiveRecords.every(({ correction }) => !correction)).toBe(true);

      const wires: SummaryWireRecord[] = [];
      const summarizerProvider = summaryProvider({ root, registry, candidate: sol, records: wires, setTransport: (next) => { queued = next; }, correctionOnFirstNormal: true });
      const rejectedProjectionBytes = composedProjectionBytes(input.providerConversation);
      const result = await compact({ strategy: 'local_exact_admission', conversations: { projectRoot: root }, input, summarizerProvider, signal: new AbortController().signal, progress: noCompactionProgress });
      expect(result.kind).toBe('compacted');
      expect(wires.length).toBeGreaterThan(2);
      expect(wires.length).toBeLessThanOrEqual(16);
      expect(wires.filter(({ correction }) => correction)).toHaveLength(1);
      expect(wires.every(({ estimated }) => estimated <= 94_000)).toBe(true);
      expect(wires.every(({ orientationBytes }) => orientationBytes >= 15_000)).toBe(true);
      expect(wires.some(({ inheritedBytes }) => inheritedBytes >= 15_000 && inheritedBytes <= 20_000)).toBe(true);
      expect(wires.every(({ body, hash }) => createHash('sha256').update(body, 'utf8').digest('hex') === hash)).toBe(true);
      const correctionIndex = wires.findIndex(({ correction }) => correction);
      expect(correctionIndex).toBeGreaterThan(0);
      expect(wires[correctionIndex]!.input.providerConversation.messages).toEqual(wires[correctionIndex - 1]!.input.providerConversation.messages);
      expect(wires[correctionIndex]!.ranges).toEqual(wires[correctionIndex - 1]!.ranges);
      const normalWires = wires.filter(({ correction }) => !correction);
      verifyExactSourceCoverage(normalWires.flatMap(({ ranges }) => ranges), fixture.expectedComponents);
      const preferredCutoffRow = endpoints[0]! - 1;
      const preferredComponents = fixture.expectedComponents.filter(({ sourceRowIndex }) => sourceRowIndex <= preferredCutoffRow);
      const firstAdditionalSource = fixture.expectedComponents[preferredComponents.length]!;
      const firstAdditionalCall = normalWires.findIndex(({ ranges }) => ranges.some(({ source }) => source === firstAdditionalSource.source));
      expect(firstAdditionalCall).toBeGreaterThan(0);
      verifyExactSourceCoverage(normalWires.slice(0, firstAdditionalCall).flatMap(({ ranges }) => ranges), preferredComponents);
      expect(inheritedSummary(normalWires[firstAdditionalCall]!.input)).toBe(normalWires[firstAdditionalCall - 1]!.returnedSummary);
      const current = readCurrentConversationSegment(root, SESSION)!;
      expect(current.conversation.effectiveCompactedHistory!.coverageCommitment.coveredThroughMessageId).toBe(fixture.lastSettledResultId);
      expect(current.conversation.effectiveCompactedHistory!.summaryText.length).toBeGreaterThan(15_000);
      expect(current.genesis.kind).toBe('compacted_segment_genesis');
      if (current.genesis.kind !== 'compacted_segment_genesis') throw new Error('Expected compacted genesis.');
      expect(current.genesis.continuation.kind).toBe('inherited_open_round');
      expect(composedProjectionBytes(result.kind === 'compacted' ? result.providerConversation : input.providerConversation)).toBeLessThan(rejectedProjectionBytes);
      const sampleAtomicGroup = current.conversation.effectiveCompactedHistory!.source.groups.find((group) => group.message_ids.includes(fixture.sampleAtomicIds[1]!));
      expect(sampleAtomicGroup?.message_ids).toEqual(fixture.sampleAtomicIds);
      expect(transportSends).toHaveLength(1 + preventiveRecords.length + wires.length);
      expect(transportSends.every(({ body, expectedBody, expectedHash }) => body === expectedBody && createHash('sha256').update(body, 'utf8').digest('hex') === expectedHash)).toBe(true);
      console.info('FULL_WINDOW_ACCEPTANCE', JSON.stringify({
        rawSourceBytes,
        sourceComponents: fixture.expectedComponents.length,
        actorTriggerLineTokens: preparedCompaction.triggerLineTokens,
        actorTriggerMessageThreshold: preparedCompaction.triggerMessageThreshold,
        actorProjectionTokens: actorTokens,
        primaryWireBytes: Buffer.byteLength(primaryVerdict.plan.request.serializedBody, 'utf8'),
        primaryWireEstimatedInputTokens: primaryVerdict.plan.request.estimatedWireInputTokens,
        primaryUsableInputTokens: plannerBinding.routeUsableInputTokens,
        summaryUsableInputTokens: 94_000,
        preventiveCalls: preventiveRecords.length,
        logicalCalls: wires.length,
        correctionCalls: 1,
        safeEndpoints: endpoints,
        summaryWireBytes: wires.map(({ bytes }) => bytes),
        summaryEstimatedInputTokens: wires.map(({ estimated }) => estimated),
        summarySourceBytes: wires.map(({ sourceBytes }) => sourceBytes),
        summaryOrientationBytes: wires.map(({ orientationBytes }) => orientationBytes),
        summaryInheritedBytes: wires.map(({ inheritedBytes }) => inheritedBytes),
      }));
    } finally {
      globalThis.fetch = originalFetch;
      rmSync(root, { recursive: true, force: true });
      rmSync(preventiveRoot, { recursive: true, force: true });
    }
  }, 120_000);
});

const SESSION = 'agent:planner:project' as const;
function appendRound(root: string, ordinal: number): void { const timestamp = `2026-08-11T00:${String(ordinal).padStart(2, '0')}:00.000Z`; appendConversationBatch({ projectRoot: root }, [{ id: `activation-${ordinal}`, session_id: SESSION, role: 'system', kind: 'activity', context_policy: ACTIVITY_ROW_POLICY, content: JSON.stringify({ event: 'activation_open', agent_name: 'planner', card_id: 'project', input_id: `00000000-0000-4000-8000-${String(ordinal).padStart(12, '0')}`, timestamp }), round_id: `r-pre-${String(ordinal).padStart(32, '0')}`, message_index: 0, block_index: 0, timestamp }, { id: `message-${ordinal}`, session_id: SESSION, role: 'user', kind: 'text', context_policy: TEXT_ROW_POLICY, content: 'x'.repeat(400), round_id: `r-user-${String(ordinal).padStart(32, '0')}`, message_index: 1, block_index: 0, timestamp }]); }
function appendProtectedRound(root: string, ordinal: number, id: string, content: string, compactionKey: string): void { const timestamp = `2026-08-11T00:${String(ordinal).padStart(2, '0')}:00.000Z`; appendConversationBatch({ projectRoot: root }, [{ id: `activation-${ordinal}`, session_id: SESSION, role: 'system', kind: 'activity', context_policy: ACTIVITY_ROW_POLICY, content: JSON.stringify({ event: 'activation_open', agent_name: 'planner', card_id: 'project', input_id: `00000000-0000-4000-8000-${String(ordinal).padStart(12, '0')}`, timestamp }), round_id: `r-pre-${String(ordinal).padStart(32, '0')}`, message_index: 0, block_index: 0, timestamp }, { id, session_id: SESSION, role: 'user', kind: 'text', context_policy: { ...TEXT_ROW_POLICY, compactable: false, compaction_key: compactionKey }, content, round_id: `r-user-${String(ordinal).padStart(32, '0')}`, message_index: 1, block_index: 0, timestamp }]); }
function appendProcessSettlement(root: string, ordinal: number, callId: string, flags: { stdout_complete: boolean; stderr_complete: boolean }): Readonly<{ process_id: string; stdout_url: string; stderr_url: string; content: string; resultId: string }> {
  const suffix = ordinal.toString(16).padStart(12, '0');
  const process_id = `proc-${suffix}`;
  const stdout_url = `work:///processes/${process_id}/stdout.log`;
  const stderr_url = `work:///processes/${process_id}/stderr.log`;
  const data = { process_id, exit_code: 0, status: 'exited', stdout: `stdout-${callId}`, stderr: `stderr-${callId}`, ...flags, stdout_url, stderr_url, stdout_bytes: Buffer.byteLength(`stdout-${callId}`), stderr_bytes: Buffer.byteLength(`stderr-${callId}`) };
  const content = JSON.stringify({ success: true, data });
  const policies = toolRowPolicies({ content });
  const inputId = `00000000-0000-4000-8000-${String(ordinal).padStart(12, '0')}`;
  const roundId = `r-user-${String(ordinal).padStart(32, '0')}`;
  const timestamp = `2026-08-11T00:${String(ordinal).padStart(2, '0')}:30.000Z`;
  const resultId = `${inputId}:tool-result:${callId}`;
  appendConversationBatch({ projectRoot: root }, [
    agentMessageSchema.parse({ id: `${inputId}:tool-call:${callId}`, session_id: SESSION, role: 'assistant', kind: 'tool_call', tool: 'run_command', tool_call_id: callId, context_policy: policies.call, content: JSON.stringify({ role: 'assistant', tool_calls: [{ id: callId, type: 'function', function: { name: 'run_command', arguments: '{}' } }] }), round_id: roundId, message_index: 2, block_index: 0, timestamp }),
    agentMessageSchema.parse({ id: resultId, session_id: SESSION, role: 'tool', kind: 'tool_result', tool: 'run_command', tool_call_id: callId, context_policy: policies.result, content, round_id: roundId, message_index: 3, block_index: 0, timestamp }),
  ]);
  return { process_id, stdout_url, stderr_url, content, resultId };
}
function invocationFor(sessionId: ConversationSessionId, messages: readonly ProviderConversationItem[]): PreparedLlmInvocationInput { const agentName = conversationSessionIdentity(sessionId).agentName; const preparedCompaction = prepareCompaction(config, 'system', [], 8_000, 2_000); return { inputId: '00000000-0000-4000-8000-000000000001', agentId: sessionId, agentName, sessionId, systemPrompt: 'system', providerConversation: { sourceSessionId: sessionId, messages: [...messages] }, tools: [], compiledToolContracts: [], terminalToolNames: [], modelParams: { temperature: 0 }, preparedCompaction, preparedContext: buildPreparedInvocationContext({ instructionText: 'system', terminalToolNames: [], compiledTools: [], dynamicBlocks: [], preparedCompaction }), capabilityRequest: {}, routePass: { kind: 'ordinary', candidateChain: [TEST_CANDIDATE] }, episodeContext: {} }; }

type ExpectedSourceComponent = Readonly<{ source: string; content: string; sourceRowIndex: number }>;
type CapturedRange = Readonly<{ source: string; start: number; end: number; totalBytes: number; hash: string; content: string }>;
type SummaryWireRecord = Readonly<{
  input: Parameters<SummarizerProviderPort['completeTurn']>[0];
  body: string;
  hash: string;
  bytes: number;
  estimated: number;
  sourceBytes: number;
  inheritedBytes: number;
  orientationBytes: number;
  correction: boolean;
  ranges: readonly CapturedRange[];
  returnedSummary: string;
}>;

function auditSizedTools(targetBytes: number): ToolDefinition[] {
  const make = (description: string): ToolDefinition[] => [{ type: 'function', function: { name: 'audit_source', description, parameters: { type: 'object', properties: { path: { type: 'string' }, query: { type: 'string' } }, required: ['path', 'query'] } } }];
  const emptyBytes = Buffer.byteLength(JSON.stringify(make('')), 'utf8');
  const tools = make('T'.repeat(targetBytes - emptyBytes));
  if (Buffer.byteLength(JSON.stringify(tools), 'utf8') !== targetBytes) throw new Error('Could not construct exact audit-sized tool surface.');
  return tools;
}

function buildFullWindowFixture(prepared: PreparedLlmInvocationInput['preparedCompaction'], dynamicBlocks: readonly ContextBlock[]): Readonly<{
  rows: readonly AgentMessage[];
  expectedComponents: readonly ExpectedSourceComponent[];
  lastSettledResultId: string;
  unsettledPairIds: readonly string[];
  sampleAtomicIds: readonly string[];
  maximumOrdinaryBundleTokens: number;
}> {
  let finalResultExtraBytes = 0;
  let built = buildRows(finalResultExtraBytes);
  for (let iteration = 0; iteration < 8; iteration++) {
    const conversation = validateFixtureRows(built.rows);
    const tokens = actorProjectionTokens(providerConversationProjection(conversation, dynamicBlocks));
    const delta = prepared.triggerMessageThreshold + 2_000 - tokens;
    if (delta >= 0 && delta < built.maximumOrdinaryBundleTokens) return built;
    finalResultExtraBytes = Math.max(0, finalResultExtraBytes + delta * 4);
    built = buildRows(finalResultExtraBytes);
  }
  throw new Error('Could not tune the full-window fixture to the prepared trigger.');

  function buildRows(extraBytes: number) {
    const rows: AgentMessage[] = [];
    const expectedComponents: ExpectedSourceComponent[] = [];
    let sampleAtomicIds: readonly string[] = [];
    let lastSettledResultId = '';
    let finalBundleStart = 0;
    let finalBundleEnd = 0;
    for (let round = 1; round <= 10; round++) {
      const inputId = `20000000-0000-4000-8000-${String(round).padStart(12, '0')}`;
      const timestamp = `2026-09-13T00:${String(round).padStart(2, '0')}:00.000Z`;
      const roundId = `r-user-${String(500 + round).padStart(32, '0')}`;
      rows.push(agentMessageSchema.parse({ id: `full-activation-${round}`, session_id: SESSION, role: 'system', kind: 'activity', context_policy: ACTIVITY_ROW_POLICY, content: JSON.stringify({ event: 'activation_open', agent_name: 'planner', card_id: 'project', input_id: inputId, timestamp }), round_id: `r-pre-${String(500 + round).padStart(32, '0')}`, message_index: 0, block_index: 0, timestamp }));
      const userContent = realisticPayload(`round-${round}-source`, round === 10 ? 120_000 : 50_000);
      rows.push(agentMessageSchema.parse({ id: `full-message-${round}`, session_id: SESSION, role: 'user', kind: 'text', context_policy: TEXT_ROW_POLICY, content: userContent, round_id: roundId, message_index: 1, block_index: 0, timestamp }));
      expectedComponents.push({ source: `full-message-${round}`, content: userContent, sourceRowIndex: rows.length - 1 });
      const toolCount = round === 10 ? 55 : 6;
      let messageIndex = 2;
      for (let toolOrdinal = 1; toolOrdinal <= toolCount; toolOrdinal++) {
        const callId = `audit-${round}-${toolOrdinal}`;
        const argumentsJson = JSON.stringify({ path: `src/segment-${round}-${toolOrdinal}.ts`, query: realisticPayload('query', 850) });
        const requestedResultBytes = 18_000 + (round === 10 && toolOrdinal === toolCount ? extraBytes : 0);
        const resultContent = JSON.stringify({ success: true, data: realisticPayload(`tool-${round}-${toolOrdinal}`, requestedResultBytes) });
        const policies = toolRowPolicies({ content: resultContent });
        const privateId = `${inputId}:provider-private:${callId}`;
        const callRowId = `${inputId}:tool-call:${callId}`;
        const resultId = `${inputId}:tool-result:${callId}`;
        const privateOutput = [{ type: 'reasoning', encrypted_content: `opaque-${round}-${toolOrdinal}` }, { type: 'function_call', call_id: callId, name: 'audit_source', arguments: argumentsJson }];
        if (round === 10 && toolOrdinal === toolCount) finalBundleStart = rows.length;
        const isPrivateVisiblePair = toolOrdinal === 1;
        if (isPrivateVisiblePair) {
          rows.push(agentMessageSchema.parse({ id: privateId, session_id: SESSION, role: 'system', kind: 'provider_private', context_policy: STRUCTURAL_ROW_POLICY.responses_private, content: JSON.stringify({ transport: 'openai-responses', source_input_id: inputId, projection_message_id: callRowId, provider: 'astra-fixture', model: 'astra-root', output: privateOutput }), round_id: roundId, message_index: messageIndex++, block_index: 0, timestamp }));
        }
        rows.push(agentMessageSchema.parse({ id: callRowId, session_id: SESSION, role: 'assistant', kind: 'tool_call', tool: 'audit_source', tool_call_id: callId, context_policy: policies.call, content: JSON.stringify({ role: 'assistant', tool_calls: [{ id: callId, type: 'function', function: { name: 'audit_source', arguments: argumentsJson } }] }), ...(isPrivateVisiblePair ? { provider_projection: { kind: 'openai_responses' as const, source_input_id: inputId, private_message_id: privateId, projection_kind: 'assistant_tool_call' as const } } : {}), round_id: roundId, message_index: messageIndex++, block_index: 0, timestamp }));
        rows.push(agentMessageSchema.parse({ id: resultId, session_id: SESSION, role: 'tool', kind: 'tool_result', tool: 'audit_source', tool_call_id: callId, context_policy: policies.result, content: resultContent, round_id: roundId, message_index: messageIndex++, block_index: 0, timestamp }));
        expectedComponents.push({ source: `${inputId}:${callId}:arguments`, content: argumentsJson, sourceRowIndex: rows.length - 1 });
        expectedComponents.push({ source: `${inputId}:${callId}:result`, content: resultContent, sourceRowIndex: rows.length - 1 });
        lastSettledResultId = resultId;
        if (round === 10 && toolOrdinal === toolCount) finalBundleEnd = rows.length;
        if (sampleAtomicIds.length === 0) sampleAtomicIds = [privateId, callRowId, resultId];
      }
    }
    const beforeFinalBundleTokens = actorProjectionTokens(providerConversationProjection(validateConversation(SESSION, rows.slice(0, finalBundleStart)), []));
    const throughFinalBundleTokens = actorProjectionTokens(providerConversationProjection(validateConversation(SESSION, rows.slice(0, finalBundleEnd)), []));
    return Object.freeze({ rows: Object.freeze(rows), expectedComponents: Object.freeze(expectedComponents), lastSettledResultId, unsettledPairIds: Object.freeze([]), sampleAtomicIds, maximumOrdinaryBundleTokens: throughFinalBundleTokens - beforeFinalBundleTokens });
  }
}

function realisticPayload(label: string, targetBytes: number): string {
  const unit = `${label}: ${'const value = source[index] + 1; // realistic implementation evidence '.repeat(12)}é漢🙂 résumé \\\\ \\" control\tline\n`;
  let value = unit.repeat(Math.ceil(targetBytes / Buffer.byteLength(unit, 'utf8')));
  while (Buffer.byteLength(value, 'utf8') > targetBytes) value = value.slice(0, -1);
  return value;
}

function validateFixtureRows(rows: readonly AgentMessage[]) {
  return validateConversation(SESSION, rows);
}

function actorProjectionTokens(projection: ReturnType<typeof providerConversationProjection>): number {
  return projection.messages.reduce((sum, item) => sum + (item.kind === 'synthetic_context'
    ? Math.max(1, estimateUtf8Tokens(`${item.role} ${item.kind} ${item.origin} ${item.block_identity} ${item.content}`))
    : estimateMessageTokens(item)), 0);
}

function safeEndpoints(conversation: ReturnType<typeof readConversation>, tailBudgetTokens: number): readonly number[] {
  const classified = classifyConversationRounds(conversation);
  const closed = classified.rounds.filter((round) => round.state === 'closed');
  let retained = 0;
  let firstRetained = closed.length;
  for (let index = closed.length - 1; index >= 0; index--) {
    const round = closed[index]!;
    if (retained + round.estimated_tokens <= tailBudgetTokens) { retained += round.estimated_tokens; firstRetained = index; continue; }
    break;
  }
  const desired = classified.preamble.length + closed.slice(0, firstRetained).reduce((count, round) => count + round.rows.length, 0);
  const base = conversation.safeSourcePrefixEnds.includes(desired) ? desired : 0;
  const furthest = conversation.safeSourcePrefixEnds.at(-1) ?? 0;
  return [base, furthest].filter((value, index, values) => value > 0 && (index === 0 || value > values[index - 1]!));
}

function invocationService(projectRoot: string, registry: ProviderRegistry): InvocationService {
  return new InvocationService({ projectRoot, registry, candidateAvailability: new MemoryCandidateAvailability(), freshness: NO_FRESHNESS_EFFECTS });
}

function summaryProvider(args: {
  root: string;
  registry: ProviderRegistry;
  candidate: Candidate;
  records: SummaryWireRecord[];
  setTransport(next: { model: string; body: string; hash: string; response: string }): void;
  correctionOnFirstNormal: boolean;
}): SummarizerProviderPort {
  const service = invocationService(args.root, args.registry);
  const capabilities = args.registry.getEffectiveCapabilities(args.candidate);
  if (!capabilities.contextWindowTokens || !capabilities.maxOutputTokens) throw new Error('Summary fixture capabilities are incomplete.');
  let normalCalls = 0;
  const serializeSummaryRequest = (input: Parameters<SummarizerProviderPort['serializeSummaryRequest']>[0]): SummaryRequestSerialization => {
    const adapter = selectLlmProtocolAdapter(capabilities.transportProtocol);
    const plan = buildCandidateRequest({ candidate: args.candidate, capabilities, adapter, systemPrompt: input.systemPrompt, providerConversation: input.providerConversation, options: { inputId: input.inputId, temperature: 0, max_tokens: 2_000, tools: [], tool_choice: 'auto', contract_id: 'internal-compaction-summary.v1', contractName: 'internal-compaction-summary', terminalToolOffered: [] } });
    return { serializedRequest: plan.request.serializedBody, requestSha256: plan.request.requestHash, estimatedInputTokens: plan.request.estimatedWireInputTokens };
  };
  return {
    candidate: args.candidate,
    contextWindowTokens: capabilities.contextWindowTokens,
    maxOutputTokens: capabilities.maxOutputTokens,
    serializeSummaryRequest,
    completeTurn: async (input, admitted, signal) => {
      const correction = input.systemPrompt.includes('6000 UTF-8 bytes');
      const response = args.correctionOnFirstNormal && !correction && normalCalls++ === 0 ? '   ' : `summary-${args.records.length + 1}: ${'S'.repeat(17_000)}`;
      args.setTransport({ model: args.candidate.model, body: admitted.serializedRequest, hash: admitted.requestSha256, response });
      const ranges = summaryRanges(input);
      const bodies = input.providerConversation.messages.map(summaryMessageBody);
      const completion = await executeInternalSummaryTurn(service, input, signal, admitted.requestSha256);
      args.records.push(Object.freeze({ input, body: admitted.serializedRequest, hash: admitted.requestSha256, bytes: Buffer.byteLength(admitted.serializedRequest, 'utf8'), estimated: admitted.estimatedInputTokens, sourceBytes: ranges.reduce((sum, range) => sum + Buffer.byteLength(range.content, 'utf8'), 0), inheritedBytes: Buffer.byteLength(inheritedSummary(input) ?? '', 'utf8'), orientationBytes: input.providerConversation.messages.reduce((sum, message, index) => message.content.includes('[kind=prepared_context ') ? sum + Buffer.byteLength(bodies[index]!, 'utf8') : sum, 0), correction, ranges, returnedSummary: response.trim() }));
      return completion;
    },
    projectProviderExchanges: (sessionId, sourceInputId, attempts, context) => service.projectProviderExchanges(sessionId, sourceInputId, attempts, context),
  };
}

function summaryMessageBody(message: ProviderConversationItem): string {
  return summaryWrappedBody(message.content);
}

function summaryWrappedBody(content: string): string {
  const match = /^\[order \d+\/\d+\] [^\n]+\n([\s\S]*)$/u.exec(content);
  if (!match) throw new Error('Invalid summary wrapper.');
  return match[1]!;
}

function inheritedSummary(input: Parameters<SummarizerProviderPort['completeTurn']>[0]): string | null {
  const message = input.providerConversation.messages.find((item) => item.content.includes('[kind=inherited_history]'));
  return message ? summaryMessageBody(message) : null;
}

function summaryRanges(input: Parameters<SummarizerProviderPort['completeTurn']>[0]): CapturedRange[] {
  return input.providerConversation.messages.flatMap((message) => {
    const wrapper = /^\[order \d+\/\d+\] (\[kind=new_source [^\n]+\])\n([\s\S]*)$/u.exec(message.content);
    if (!wrapper) return [];
    const label = /source=(\S+) .*range=(\d+):(\d+) total_bytes=(\d+) source_sha256=([0-9a-f]{64})/u.exec(wrapper[1]!);
    if (!label) throw new Error(`Invalid source range label: ${wrapper[1]}`);
    return [{ source: label[1]!, start: Number(label[2]), end: Number(label[3]), totalBytes: Number(label[4]), hash: label[5]!, content: wrapper[2]! }];
  });
}

function verifyExactSourceCoverage(ranges: readonly CapturedRange[], expected: readonly ExpectedSourceComponent[]): void {
  expect(ranges.filter((range, index) => index === 0 || range.source !== ranges[index - 1]!.source).map(({ source }) => source)).toEqual(expected.map(({ source }) => source));
  for (const component of expected) {
    const parts = ranges.filter(({ source }) => source === component.source);
    expect(parts).not.toHaveLength(0);
    expect(parts[0]!.start).toBe(0);
    expect(parts.at(-1)!.end).toBe(Buffer.byteLength(component.content, 'utf8'));
    expect(parts.every((part, index) => index === 0 || part.start === parts[index - 1]!.end)).toBe(true);
    expect(parts.every((part) => Buffer.byteLength(part.content, 'utf8') === part.end - part.start)).toBe(true);
    expect(parts.every((part) => part.totalBytes === Buffer.byteLength(component.content, 'utf8') && part.hash === createHash('sha256').update(component.content, 'utf8').digest('hex'))).toBe(true);
    expect(parts.map(({ content }) => content).join('')).toBe(component.content);
  }
}

function composedProjectionBytes(projection: ReturnType<typeof providerConversationProjection>): number {
  return Buffer.byteLength(JSON.stringify(projection.messages.map((item) => item.kind === 'synthetic_context'
    ? [item.kind, item.origin, item.block_identity, item.role, item.content]
    : [item.id, item.role, item.kind, item.content])), 'utf8');
}
