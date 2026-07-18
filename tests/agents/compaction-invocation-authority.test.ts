import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { InvocationService, type InvocationRequest } from '../../src/agents/invocation-service.js';
import type { EffectiveProviderCapabilities } from '../../src/agents/provider-capabilities.js';
import type { Candidate } from '../../src/contracts/provider-candidate.js';
import { prepareCompaction, type AutonomousCompactionPolicy } from '../../src/runtime/actors/compaction/compactor.js';
import { testAppLogs } from '../helpers/app-logs.js';
import type { LlmCallFn } from '../../src/agents/llm-contracts.js';
import { appendConversationBatch } from '../../src/persistence/conversation-file.js';
import { compactedConversationFixture } from '../helpers/compacted-conversation-fixture.js';
import { initProjectTree } from '../helpers/canonical-project.js';
import { CardService } from '../../src/cards/card-service.js';
import { PlanningCardProcessorActor } from '../../src/runtime/actors/planning-card-processor-actor.js';
import { TerminalCardProcessorActor } from '../../src/runtime/actors/terminal-card-processor-actor.js';
import type { LLMProviderPort } from '../../src/runtime/actors/llm-actor.js';
import { createTestPromptTemplateRegistry } from '../helpers/prompt-template-registry.js';
import { createTestProcessRunner } from '../helpers/test-process-runner.js';
import { testAutonomousCompaction } from '../helpers/llm-test-helpers.js';

const candidate: Candidate = { provider: 'test', account: null, model: 'model' };
const config: AutonomousCompactionPolicy = { input_budget_tokens: 1000, trigger_fraction: 0.8, completion_reserve_fraction: 0.2, merge_line_fraction: 0.3, summary_line_fraction: 0.5, escalate_merge_line_fraction: 0.4, escalate_summary_line_fraction: 0.55, snap: 'compact_straddler' };
const roots: string[] = [];
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });

describe('singular invocation completion authority', () => {
  it.each([
    { transportProtocol: 'openai-chat-completions' as const, outputField: 'max_tokens' as const },
    { transportProtocol: 'openai-responses' as const, outputField: 'max_output_tokens' as const },
    { transportProtocol: 'openai-codex-backend' as const, outputField: null },
  ])('uses prepared completion for $transportProtocol admission and transport', async ({ transportProtocol, outputField }) => {
    let observedOptions: Parameters<LlmCallFn>[4] | undefined;
    const observed: LlmCallFn = async (_candidate, _prompt, _providerConversation, _session, options) => { observedOptions = options; return { result: { kind: 'message', content: 'ok' }, provider_exchanges: [] }; };
    const service = invocationService(capabilities(transportProtocol), observed);
    const request = preparedRequest();

    await service.invokeCall(request, candidate);

    const options = observedOptions!;
    expect(options.max_tokens).toBe(200);
    expect(options.builtCandidateRequest).toBeDefined();
    expect(options.builtCandidateRequest!.body[outputField ?? 'max_output_tokens']).toBe(outputField ? 200 : undefined);
    if (!outputField) expect(options.builtCandidateRequest!.body).not.toHaveProperty('max_tokens');
  });

  it('rejects prepared candidates by the prepared output value alone', async () => {
    const call = jest.fn();
    const service = invocationService({ ...capabilities('openai-chat-completions'), maxOutputTokens: 199 }, call as never);
    await expect(service.invokeCall(preparedRequest(), candidate)).rejects.toThrow(/max_output_too_small/);
    expect(call).not.toHaveBeenCalled();
  });

  it('uses an exact requested completion below the reserved capacity for admission and transport', async () => {
    let observedOptions: Parameters<LlmCallFn>[4] | undefined;
    const observed: LlmCallFn = async (_candidate, _prompt, _providerConversation, _session, options) => { observedOptions = options; return { result: { kind: 'message', content: 'ok' }, provider_exchanges: [] }; };
    const service = invocationService(capabilities('openai-chat-completions'), observed);
    const request = preparedRequest(137);

    await service.invokeCall(request, candidate);

    expect(request.preparedCompaction).toMatchObject({ reservedCompletionTokens: 200, requestedCompletionTokens: 137 });
    expect(observedOptions!.max_tokens).toBe(137);
    expect(observedOptions!.builtCandidateRequest!.body.max_tokens).toBe(137);
  });

  it('keeps direct nonpersisting summarization on ordinary maxTokens without compacted admission', async () => {
    const maxTokens = 2000;
    let observedOptions: Parameters<LlmCallFn>[4] | undefined;
    const observed: LlmCallFn = async (_candidate, _prompt, _providerConversation, _session, options) => { observedOptions = options; return { result: { kind: 'message', content: 'ok' }, provider_exchanges: [] }; };
    const service = invocationService({ ...capabilities('openai-responses'), contextWindowTokens: undefined, maxOutputTokens: undefined }, observed);
    const request: InvocationRequest = { inputId: '00000000-0000-4000-8000-000000000001', role: 'analyst', sessionId: 'analyst:global', systemPrompt: 'system', providerConversation: { sourceSessionId: 'analyst:global', messages: [] }, tools: [], terminalToolNames: [], modelParams: maxTokens === undefined ? {} : { maxTokens }, capabilityRequest: {} };
    await service.invokeCall(request, candidate);
    const options = observedOptions!;
    expect(options.max_tokens).toBe(maxTokens);
    expect(options.builtCandidateRequest).toBeUndefined();
  });

  it('activates a fresh compacted stable planner without re-compaction and sends only C2 plus its suffix', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'saivage-fresh-planner-'));
    roots.push(projectRoot);
    initProjectTree(projectRoot);
    const fixture = compactedConversationFixture('planner:project');
    appendConversationBatch(projectRoot, fixture.rows);
    const store = new CardService(projectRoot);
    const captured: import('../../src/runtime/actors/llm-invocation.js').LlmInvocationInput[] = [];
    let call = 0;
    const provider: LLMProviderPort = { completeTurn: async (input) => {
      captured.push(input);
      return { result: { kind: 'tool_calls' as const, tool_calls: [{ id: `call-${call}`, type: 'function' as const, function: ++call === 1
        ? { name: 'write', arguments: JSON.stringify({ path: 'record:///status.md?v=next', content: 'blocked' }) }
        : { name: 'emit_result', arguments: JSON.stringify({ status: 'blocked', summary: 'blocked' }) } }] }, provider_exchanges: [] };
    } };
    const actor = new PlanningCardProcessorActor({ projectRoot, cardId: 'project', store, children: { get: () => null }, cancelCard: async () => { throw new Error('unused'); }, provider, conversations: { projectRoot }, appLogs: testAppLogs(projectRoot), promptTemplates: createTestPromptTemplateRegistry(), runtimeProjectionChanged() {}, ...testAutonomousCompaction, compactionConfig: { ...config, input_budget_tokens: 100000 } });
    actor.start();

    await expect(actor.activate({ activationId: 'activation', card: store.read('project')!, caller: { kind: 'root' }, notificationDelivery: { selectNotifications: () => [], removeNotifications: () => undefined }, claimResult: jest.fn() }, new AbortController().signal)).resolves.toMatchObject({ status: 'blocked' });

    expect(captured.length).toBeGreaterThan(0);
    for (const input of captured) {
      expect(input.sessionId).toBe('planner:project');
      expect(input.providerConversation.sourceSessionId).toBe('planner:project');
      expect(input.providerConversation.messages.filter((row) => row.id.endsWith(':rendered'))).toHaveLength(1);
      expect(input.providerConversation.messages.find((row) => row.id.endsWith(':rendered'))?.content).toContain(fixture.c2Summary);
      expect(JSON.stringify(input.providerConversation.messages)).not.toContain(fixture.c1Summary);
      expect(input.providerConversation.messages.some((row) => row.kind === 'context_compaction')).toBe(false);
      for (const id of fixture.c1CoveredIds) expect(input.providerConversation.messages.some((row) => row.id === id)).toBe(false);
    }
  });

  it('uses the same latest-only stable-session contract in reviewer and executor builders', () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'saivage-role-builders-'));
    roots.push(projectRoot);
    initProjectTree(projectRoot);
    const store = new CardService(projectRoot);
    const child = store.create({ type: 'code', parent: 'project', title: 'Child', brief: 'Work', status: 'backlog', tags: [], priority: 0, urgency: 'normal', created_by: 'planner', depends_on: [], related: [] });
    const reviewerFixture = compactedConversationFixture('reviewer:project');
    const executorFixture = compactedConversationFixture(`executor:${child.id}`);
    appendConversationBatch(projectRoot, reviewerFixture.rows);
    appendConversationBatch(projectRoot, executorFixture.rows);
    const provider = { completeTurn: jest.fn() as never };
    const planner = new PlanningCardProcessorActor({ projectRoot, cardId: 'project', store, children: { get: () => null }, cancelCard: async () => { throw new Error('unused'); }, provider, conversations: { projectRoot }, appLogs: testAppLogs(projectRoot), promptTemplates: createTestPromptTemplateRegistry(), runtimeProjectionChanged() {}, ...testAutonomousCompaction, compactionConfig: { ...config, input_budget_tokens: 100000 } });
    const plannerInternals = planner as unknown as {
      reviewerInvocationSurface(cardId: string, sessionId: string): unknown;
      captureReviewerCurrentness(input: unknown): unknown;
      buildReviewerLlmInput(input: unknown, sessionId: string, currentness: unknown, surface: unknown): import('../../src/runtime/actors/llm-invocation.js').LlmInvocationInput;
    };
    const activationInput = { activationId: 'activation', card: store.read('project')!, caller: { kind: 'root' }, notificationDelivery: { selectNotifications: () => [], removeNotifications: () => undefined }, claimResult: jest.fn() };
    const reviewer = plannerInternals.buildReviewerLlmInput(activationInput, 'reviewer:project', plannerInternals.captureReviewerCurrentness(activationInput), plannerInternals.reviewerInvocationSurface('project', 'reviewer:project'));

    const runner = createTestProcessRunner(projectRoot);
    const executor = new TerminalCardProcessorActor({ projectRoot, cardId: child.id, store, provider, processRunner: runner, conversations: { projectRoot }, appLogs: testAppLogs(projectRoot), promptTemplates: createTestPromptTemplateRegistry(), runtimeProjectionChanged() {}, ...testAutonomousCompaction, compactionConfig: { ...config, input_budget_tokens: 100000 } });
    const executorInternals = executor as unknown as {
      executorInvocationSurface(ownerId: string, scope: unknown): unknown;
      buildLlmInput(input: unknown, surface: unknown): import('../../src/runtime/actors/llm-invocation.js').LlmInvocationInput;
    };
    const scope = runner.createDirectScope(runner.runtimeRootScope, 'test-executor', 'runtime_card');
    const executorInput = executorInternals.buildLlmInput({ ...activationInput, card: store.read(child.id)!, caller: { kind: 'parent', cardId: 'project' } }, executorInternals.executorInvocationSurface('activation', scope));

    for (const [input, fixture] of [[reviewer, reviewerFixture], [executorInput, executorFixture]] as const) {
      expect(input.sessionId).toBe(input.providerConversation.sourceSessionId);
      expect(input.providerConversation.messages.filter((row) => row.id.endsWith(':rendered'))).toHaveLength(1);
      expect(input.providerConversation.messages.find((row) => row.id.endsWith(':rendered'))?.content).toContain(fixture.c2Summary);
      expect(JSON.stringify(input.providerConversation.messages)).not.toContain(fixture.c1Summary);
      expect(input.providerConversation.messages.some((row) => row.kind === 'context_compaction')).toBe(false);
    }
  });
});

function preparedRequest(requestedCompletionTokens?: number): InvocationRequest {
  return { inputId: '00000000-0000-4000-8000-000000000001', role: 'planner', sessionId: 'planner:project', systemPrompt: 'system', providerConversation: { sourceSessionId: 'planner:project', messages: [] }, tools: [], terminalToolNames: [], modelParams: {}, preparedCompaction: prepareCompaction(config, 'system', [], requestedCompletionTokens), capabilityRequest: {} };
}

function capabilities(transportProtocol: EffectiveProviderCapabilities['transportProtocol']): EffectiveProviderCapabilities {
  return { transportProtocol, toolsMode: 'native', exclusiveToolChoiceSupport: 'native', streaming: false, contextWindowTokens: 10000, maxOutputTokens: 1000, quirks: [] };
}

function invocationService(effective: EffectiveProviderCapabilities, llmCallFn: LlmCallFn): InvocationService {
  const root = mkdtempSync(join(tmpdir(), 'saivage-compaction-authority-'));
  roots.push(root);
  const service = new InvocationService({ projectRoot: root, saivageDir: root, appLogs: testAppLogs(root), registry: { getEffectiveCapabilities: () => effective } as never, router: {} as never, candidateAvailability: {} as never, llmCallFn });
  return service;
}
