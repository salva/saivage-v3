import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { saivageConfigSchema } from '../../src/agents/config-schema.js';
import { InvocationService, type InvocationRequest } from '../../src/agents/invocation-service.js';
import { ProviderTurnFailure, type ProviderTurnCompletion } from '../../src/agents/llm-contracts.js';
import { LlmRequestError } from '../../src/contracts/llm-failure.js';
import type { ProviderExchangeAttempt } from '../../src/contracts/provider-exchange.js';
import { createRuntimeApplication } from '../../src/application/runtime-composition.js';
import { ReadModelChangeBroadcaster } from '../../src/application/read-model-changes.js';
import { CardService } from '../../src/cards/card-service.js';
import { EventBus } from '../../src/events/index.js';
import { createErrorLog, createEventLog } from '../../src/observability/index.js';
import { readAppLogEntries } from '../../src/persistence/app-log.js';
import { appendConversationBatch, readConversation } from '../../src/persistence/conversation-file.js';
import { providerConversationProjection } from '../../src/runtime/actors/conversation-session.js';
import { estimateMessageTokens } from '../../src/runtime/actors/compaction/round-classifier.js';
import { initProjectTree, testConfigAuthority } from '../helpers/canonical-project.js';

const roots: string[] = [];
afterEach(() => { jest.restoreAllMocks(); while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true }); });

describe('ordinary-runtime last-chance context compaction E2E', () => {
  it('recovers one below-threshold planner rejection and completes through ordinary tool handling', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'saivage-last-chance-e2e-'));
    roots.push(projectRoot);
    initProjectTree(projectRoot);
    appendPlannerHistory(projectRoot);

    const requests: InvocationRequest[] = [];
    const ordering: string[] = [];
    let triggeringInputId: string | null = null;
    let triggeringCalls = 0;
    let plannerCalls = 0;
    let contextFailures = 0;
    let firstEstimate = -1;
    let firstTrigger = -1;
    let compactionsAtFirstPass = -1;
    let compactionsAtSecondPass = -1;

    jest.spyOn(InvocationService.prototype, 'invokeWithRecovery').mockImplementation(async (request) => {
      requests.push(request);
      if (request.role === 'analyst') {
        ordering.push(`summary:${request.sessionId}:${request.inputId}`);
        return summaryCompletion(request);
      }

      plannerCalls += 1;
      ordering.push(`planner-${plannerCalls}:${request.inputId}`);
      if (plannerCalls === 1) {
        triggeringInputId = request.inputId;
        triggeringCalls += 1;
        if (!request.preparedCompaction) throw new Error('Planner request was not prepared.');
        firstEstimate = request.providerConversation.messages.reduce((sum, row) => sum + estimateMessageTokens(row), 0);
        firstTrigger = request.preparedCompaction.triggerMessageThreshold;
        compactionsAtFirstPass = readConversation(projectRoot, 'planner:project').compactions.length;
        contextFailures += 1;
        throw contextFailure(request);
      }
      if (request.inputId === triggeringInputId) {
        triggeringCalls += 1;
        compactionsAtSecondPass = readConversation(projectRoot, 'planner:project').compactions.length;
        return toolCompletion(request, 'write-after-recovery', 'write', { path: 'record:///status.md?v=next', content: 'Recovered after one authoritative context rejection.' });
      }
      return toolCompletion(request, 'emit-after-recovery', 'emit_result', { status: 'done', summary: 'Recovered and completed.' });
    });

    const config = saivageConfigSchema.parse({
      models: { default: ['work-model'], max_tokens: { analyst: 2400 } },
      providers: { test: { models: ['work-model', 'org/summary/model'] } },
      compaction: { enabled: true, input_budget_tokens: 12000, summarizer_candidate: { provider: 'test', account: null, model: 'org/summary/model' } },
    });
    const eventBus = new EventBus();
    const readModelChanges = new ReadModelChangeBroadcaster();
    const appLogs = { projectRoot, changes: readModelChanges };
    const cards = new CardService(projectRoot, eventBus, readModelChanges);
    const application = createRuntimeApplication({ projectRoot, processIdentity: { pid: 4242, startedAt: '2026-07-18T00:00:00.000Z' }, config, configAuthority: testConfigAuthority(projectRoot), eventBus, eventLogger: createEventLog(projectRoot, appLogs, eventBus), errorLogger: createErrorLog(projectRoot, appLogs, eventBus), appLogs, cardStore: cards, readModelChanges });

    await application.runtimeApi.start();
    await application.runtimeApi.startProject();
    await waitUntil(() => application.runtimeApi.getStatus().status === 'stopped');

    expect(cards.read('project')).toMatchObject({ status: 'done', lifecycle: { result: { kind: 'done', summary: 'Recovered and completed.' } } });
    expect(firstEstimate).toBeGreaterThan(0);
    expect(firstEstimate).toBeLessThan(firstTrigger);
    expect(compactionsAtFirstPass).toBe(0);
    expect(compactionsAtSecondPass).toBe(1);
    expect(contextFailures).toBe(1);
    expect(triggeringCalls).toBe(2);
    expect(plannerCalls).toBe(3);

    const conversation = readConversation(projectRoot, 'planner:project');
    expect(conversation.compactions).toHaveLength(1);
    expect(conversation.physicalRows.filter((row) => row.kind === 'context_compaction')).toHaveLength(1);
    const triggerMarkers = conversation.sourceRows.filter((row) => {
      if (row.kind !== 'activity') return false;
      const content = JSON.parse(row.content) as { event?: unknown; input_id?: unknown };
      return content.event === 'activation_open' && content.input_id === triggeringInputId;
    });
    expect(triggerMarkers).toHaveLength(1);

    const plannerRequests = requests.filter((request) => request.role === 'planner');
    const triggerRequests = plannerRequests.filter((request) => request.inputId === triggeringInputId);
    expect(triggerRequests).toHaveLength(2);
    expect(triggerRequests[0]!.providerConversation).not.toEqual(triggerRequests[1]!.providerConversation);
    expect(triggerRequests[1]!.providerConversation.messages.filter((row) => row.id.endsWith(':rendered'))).toHaveLength(1);
    expect(triggerRequests[1]!.providerConversation.messages.some((row) => row.kind === 'context_compaction')).toBe(false);

    const summaryRequests = requests.filter((request) => request.role === 'analyst');
    expect(summaryRequests.length).toBeGreaterThan(0);
    expect(summaryRequests.every((request) => request.sessionId.startsWith('summary:'))).toBe(true);
    expect(new Set(summaryRequests.map((request) => request.inputId)).size).toBe(summaryRequests.length);
    expect(summaryRequests.every((request) => request.inputId !== triggeringInputId)).toBe(true);
    expect(summaryRequests.every((request) => JSON.stringify(request.candidateChain) === JSON.stringify([{ provider: 'test', account: null, model: 'org/summary/model' }]))).toBe(true);
    expect(ordering[0]).toBe(`planner-1:${triggeringInputId}`);
    expect(ordering.findIndex((entry) => entry.startsWith('summary:'))).toBeGreaterThan(0);
    expect(ordering.indexOf(`planner-2:${triggeringInputId}`)).toBeGreaterThan(ordering.findIndex((entry) => entry.startsWith('summary:')));

    const exchanges = readAppLogEntries(projectRoot, 'provider_exchange');
    const triggeringEvidence = exchanges.filter((entry) => entry.data.session_id === 'planner:project' && entry.data.source_input_id === triggeringInputId);
    expect(triggeringEvidence).toHaveLength(2);
    expect(triggeringEvidence.map((entry) => [entry.data.attempt_index, entry.data.payload.status, entry.data.payload.source_input_id])).toEqual([
      [0, 'error', triggeringInputId],
      [1, 'ok', triggeringInputId],
    ]);
    const summaryEvidence = exchanges.filter((entry) => entry.data.session_id.startsWith('summary:'));
    expect(summaryEvidence).toHaveLength(summaryRequests.length);
    expect(new Set(summaryEvidence.map((entry) => `${entry.data.session_id}/${entry.data.source_input_id}`))).toEqual(new Set(summaryRequests.map((request) => `${request.sessionId}/${request.inputId}`)));
    expect(summaryEvidence.every((entry) => entry.data.source_input_id !== triggeringInputId && entry.data.attempt_index === 0)).toBe(true);
    expect(summaryEvidence.every((entry) => entry.data.payload.status === 'ok' && entry.data.payload.assistant_output_ids.length === 0)).toBe(true);

    const latestProjection = providerConversationProjection(conversation);
    const rendered = latestProjection.messages.filter((row) => row.id.endsWith(':rendered'));
    expect(rendered).toHaveLength(1);
    expect(rendered[0]!.content).toBe(conversation.latestCompaction!.renderedContext);
    expect(latestProjection.messages.some((row) => row.kind === 'context_compaction')).toBe(false);
  });
});

function appendPlannerHistory(projectRoot: string): void {
  appendConversationBatch(projectRoot, Array.from({ length: 5 }, (_, index) => {
    const ordinal = index + 1;
    const inputId = `00000000-0000-4000-8000-${String(ordinal).padStart(12, '0')}`;
    const timestamp = `2026-07-17T00:00:${String(ordinal).padStart(2, '0')}.000Z`;
    return [
      { id: `activation-${ordinal}`, session_id: 'planner:project' as const, role: 'system' as const, kind: 'activity' as const, content: JSON.stringify({ event: 'activation_open', role: 'planner', card_id: 'project', input_id: inputId, timestamp }), round_id: `r-pre-${String(ordinal).padStart(32, '0')}`, message_index: 0, block_index: 0, timestamp },
      { id: `history-${ordinal}`, session_id: 'planner:project' as const, role: 'user' as const, kind: 'text' as const, content: `${ordinal}:${'x'.repeat(4000)}`, round_id: `r-user-${String(ordinal).padStart(32, '0')}`, message_index: 1, block_index: 0, timestamp },
    ];
  }).flat());
}

function contextFailure(request: InvocationRequest): ProviderTurnFailure {
  const originalFailure = new LlmRequestError({ kind: 'input_context_exhausted', provider: 'test', status: 400, message: 'strict context rejection' });
  return new ProviderTurnFailure({ failure_phase: 'provider_attempt', provider_exchanges: [attempt(request, 'error', 400)], originalFailure });
}

function summaryCompletion(request: InvocationRequest): ProviderTurnCompletion {
  return { result: { kind: 'message', content: 'concise summary' }, provider_exchanges: [attempt(request, 'ok', 200)] };
}

function toolCompletion(request: InvocationRequest, id: string, name: string, args: object): ProviderTurnCompletion {
  return { result: { kind: 'tool_calls', tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] }, provider_exchanges: [attempt(request, 'ok', 200)] };
}

function attempt(request: InvocationRequest, status: 'ok' | 'error', responseStatus: number): ProviderExchangeAttempt {
  const base = { contract_id: 'e2e.v1', contract_name: 'last-chance-e2e', transport: 'generic' as const, provider: 'test', model: request.role === 'analyst' ? 'org/summary/model' : 'work-model', source_input_id: request.inputId, attempt_index: 0, request_params: {}, started_at: '2026-07-17T00:10:00.000Z', completed_at: '2026-07-17T00:10:00.001Z', response_status: responseStatus, terminal_tool_fired: null };
  return status === 'ok' ? { ...base, status } : { ...base, status, error: { name: 'LlmRequestError', message: 'strict context rejection', status: responseStatus } };
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 1000; attempt += 1) { if (predicate()) return; await new Promise((resolve) => setTimeout(resolve, 2)); }
  throw new Error('runtime did not settle');
}
