import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { saivageConfigSchema } from '../../src/agents/config-schema.js';
import { DEFAULT_CARD_PROCESSES } from '../../src/agents/default-card-processes.js';
import { InvocationService, type InvocationRequest } from '../../src/agents/invocation-service.js';
import { ProviderTurnFailure, type ProviderTurnCompletion } from '../../src/agents/llm-contracts.js';
import { createRuntimeApplication } from '../../src/application/runtime-composition.js';
import { CardService } from '../../src/cards/card-service.js';
import { LlmRequestError } from '../../src/contracts/llm-failure.js';
import type { ProviderExchangeAttempt } from '../../src/contracts/provider-exchange.js';
import { createEventLog } from '../../src/observability/index.js';
import { readConversation } from '../../src/persistence/conversation-file.js';
import { providerConversationProjection } from '../../src/runtime/actors/conversation-session.js';
import { classifyConversationRounds, estimateMessageTokens } from '../../src/runtime/actors/compaction/round-classifier.js';
import { initProjectTree, testConfigAuthority } from '../helpers/canonical-project.js';
import { testAutonomousCompaction } from '../helpers/llm-test-helpers.js';
import { ManagedProcessGroupRegistry } from '../../src/runtime/managed-process-group-registry.js';
import { ProcessRunner } from '../../src/runtime/process-runner.js';

const roots: string[] = [];

afterEach(() => {
  jest.restoreAllMocks();
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe('ordinary-runtime Analyst continuation compaction E2E', () => {
  it('compacts a marker-derived completed round and retries one rejected tool continuation without replay', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'saivage-analyst-continuation-e2e-'));
    roots.push(projectRoot);
    initProjectTree(projectRoot);

    const allRequests: InvocationRequest[] = [];
    const primaryRequests: InvocationRequest[] = [];
    let continuationInputId: string | null = null;
    let compactionsAtRejectedPass = -1;
    let compactionsAtRetry = -1;

    jest.spyOn(InvocationService.prototype, 'invokeWithRecovery').mockImplementation(async (request) => {
      allRequests.push(request);
      if (request.sessionId.startsWith('summary:')) return summaryCompletion(request);

      primaryRequests.push(request);
      switch (primaryRequests.length) {
        case 1:
          return messageCompletion(request, 'Completed baseline Analyst round.');
        case 2: {
          const harmlessTool = request.tools.find((tool) => tool.function.name === 'list_cards');
          if (!harmlessTool) throw new Error('Ordinary Analyst surface did not expose list_cards.');
          return toolCompletion(request, 'list-cards-once', harmlessTool.function.name, {});
        }
        case 3:
          continuationInputId = request.inputId;
          compactionsAtRejectedPass = readConversation(projectRoot, 'analyst:global').compactions.length;
          throw contextFailure(request);
        case 4:
          compactionsAtRetry = readConversation(projectRoot, 'analyst:global').compactions.length;
          return messageCompletion(request, 'Final answer after compacted continuation retry.');
        default:
          throw new Error(`Unexpected Analyst primary provider pass ${primaryRequests.length}.`);
      }
    });

    const config = saivageConfigSchema.parse({
      models: { default: ['work-model'], max_tokens: { analyst: 4096 } },
      providers: { test: { models: ['work-model', 'org/summary/model'] } },
      compaction: {
        enabled: true,
        input_budget_tokens: 50000,
        summarizer_candidate: { provider: 'test', account: null, model: 'org/summary/model' },
      },
      card_processes: DEFAULT_CARD_PROCESSES,
    });
    const freshness = { runtimeChanged: jest.fn(), cardProjectionChanged: jest.fn(), agentsChanged: jest.fn(), conversationChanged: jest.fn(), timelineChanged: jest.fn() };
    const cardStore = new CardService(projectRoot, freshness);
    const processRegistry = new ManagedProcessGroupRegistry();
    const runtimeProcessRootScope = processRegistry.createContainerScope(processRegistry.rootScope, 'runtime-cards');
    const analystProcessRootScope = processRegistry.createContainerScope(processRegistry.rootScope, 'analyst-sessions');
    const application = createRuntimeApplication({
      processIdentity: { pid: 4242, startedAt: '2026-07-18T00:00:00.000Z' },
      projectRoot,
      config,
      configAuthority: testConfigAuthority(projectRoot),
      eventLogger: createEventLog(projectRoot, freshness.timelineChanged),
      cardStore,
      freshness,
      processRunner: new ProcessRunner(projectRoot, processRegistry),
      runtimeProcessRootScope,
      analystProcessRootScope,
      mcpToolInvocation: testAutonomousCompaction.mcpToolInvocation,
    });

    await application.analystRuntime.submit({
      userContent: `baseline history ${'x'.repeat(5000)}`,
    });
    const currentUserContent = 'List the current cards once, then answer from that harmless read.';
    const response = await application.analystRuntime.submit({
      userContent: currentUserContent,
      workspaceContext: { view: 'cards', entityId: 'project', refinement: { tab: 'tree' } },
    });

    expect(response).toMatchObject({ sessionId: 'analyst:global', restart: null });
    expect(response.toolInvocations).toHaveLength(1);
    expect(response.toolInvocations![0]).toMatchObject({ tool: 'list_cards', params: {}, result: { success: true } });
    expect(primaryRequests).toHaveLength(4);
    expect(continuationInputId).not.toBeNull();
    expect(primaryRequests[2]!.inputId).toBe(continuationInputId);
    expect(primaryRequests[3]!.inputId).toBe(continuationInputId);
    expect(primaryRequests[1]!.inputId).not.toBe(continuationInputId);
    expect(compactionsAtRejectedPass).toBe(0);
    expect(compactionsAtRetry).toBe(1);
    expect(messageEstimate(primaryRequests[2]!)).toBeGreaterThan(messageEstimate(primaryRequests[1]!));

    const summaryRequests = allRequests.filter((request) => request.sessionId.startsWith('summary:'));
    expect(summaryRequests.length).toBeGreaterThan(0);
    expect(summaryRequests.every((request) => JSON.stringify(request.candidateChain) === JSON.stringify([
      { provider: 'test', account: null, model: 'org/summary/model' },
    ]))).toBe(true);
    expect(summaryRequests.every((request) => request.inputId !== continuationInputId)).toBe(true);

    const conversation = readConversation(projectRoot, 'analyst:global');
    const classified = classifyConversationRounds('analyst:global', conversation.sourceRows);
    expect(classified.preamble).toEqual([]);
    expect(classified.rounds).toHaveLength(2);
    const completedRound = classified.rounds[0]!;
    const currentRound = classified.rounds[1]!;
    expect(conversation.physicalRows.filter((row) => row.kind === 'context_compaction')).toHaveLength(1);
    expect(conversation.latestCompaction!.groups.flatMap((group) => group.rounds).map((round) => round.label)).toContain(completedRound.round_id);
    expect(conversation.latestCompaction!.groups.flatMap((group) => group.rounds).map((round) => round.label)).not.toContain(currentRound.round_id);

    const currentRows = currentRound.rows.map((row) => row.message);
    const currentMarker = JSON.parse(currentRows[0]!.content) as Record<string, unknown>;
    const acceptedOperationId = currentMarker['input_id'];
    expect(typeof acceptedOperationId).toBe('string');
    expect(acceptedOperationId).not.toBe(primaryRequests[1]!.inputId);
    expect(new Set(primaryRequests.map((request) => request.inputId)).size).toBe(3);
    expect(currentMarker).toEqual({
      event: 'activation_open',
      role: 'analyst',
      input_id: acceptedOperationId,
      timestamp: currentRows[0]!.timestamp,
    });
    expect(currentRows.slice(0, 3).map((row) => [row.role, row.kind, row.content])).toEqual([
      ['system', 'activity', currentRows[0]!.content],
      ['system', 'text', '[workspace-context]\nview: cards\nentity: project\nrefinement: tab=tree'],
      ['user', 'text', currentUserContent],
    ]);
    expect(conversation.sourceRows.filter((row) => row.kind === 'activity' && JSON.parse(row.content).input_id === acceptedOperationId)).toHaveLength(1);
    expect(conversation.sourceRows.filter((row) => row.content === currentUserContent)).toHaveLength(1);
    expect(conversation.sourceRows.filter((row) => row.content === '[workspace-context]\nview: cards\nentity: project\nrefinement: tab=tree')).toHaveLength(1);
    expect(conversation.sourceRows.filter((row) => row.kind === 'tool_call' && row.tool_call_id === 'list-cards-once')).toHaveLength(1);
    expect(conversation.sourceRows.filter((row) => row.kind === 'tool_result' && row.tool_call_id === 'list-cards-once')).toHaveLength(1);
    expect(conversation.sourceRows.filter((row) => row.role === 'assistant' && row.kind === 'text' && row.content === 'Final answer after compacted continuation retry.')).toHaveLength(1);

    const retryProjection = primaryRequests[3]!.providerConversation;
    expect(retryProjection.sourceSessionId).toBe('analyst:global');
    expect(retryProjection.messages.filter((row) => row.id.endsWith(':rendered'))).toHaveLength(1);
    expect(retryProjection.messages.some((row) => row.kind === 'context_compaction')).toBe(false);
    const latestProjection = providerConversationProjection(conversation);
    expect(latestProjection.sourceSessionId).toBe('analyst:global');
    expect(latestProjection.messages.filter((row) => row.id.endsWith(':rendered'))).toHaveLength(1);
    expect(latestProjection.messages.find((row) => row.id.endsWith(':rendered'))!.content).toBe(conversation.latestCompaction!.renderedContext);
    expect(latestProjection.messages.some((row) => row.kind === 'context_compaction')).toBe(false);
  });
});

function messageEstimate(request: InvocationRequest): number {
  return request.providerConversation.messages.reduce((total, row) => total + estimateMessageTokens(row), 0);
}

function contextFailure(request: InvocationRequest): ProviderTurnFailure {
  return new ProviderTurnFailure({
    failure_phase: 'provider_attempt',
    provider_exchanges: [attempt(request, 'error', 400)],
    originalFailure: new LlmRequestError({ kind: 'input_context_exhausted', provider: 'test', status: 400, message: 'strict continuation context rejection' }),
  });
}

function summaryCompletion(request: InvocationRequest): ProviderTurnCompletion {
  return messageCompletion(request, 'Fixed-candidate compacted summary.');
}

function messageCompletion(request: InvocationRequest, content: string): ProviderTurnCompletion {
  return { result: { kind: 'message', content }, provider_exchanges: [attempt(request, 'ok', 200)] };
}

function toolCompletion(request: InvocationRequest, id: string, name: string, args: object): ProviderTurnCompletion {
  return {
    result: { kind: 'tool_calls', tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] },
    provider_exchanges: [attempt(request, 'ok', 200)],
  };
}

function attempt(request: InvocationRequest, status: 'ok' | 'error', responseStatus: number): ProviderExchangeAttempt {
  const base = {
    contract_id: 'analyst-continuation.e2e.v1',
    contract_name: 'analyst-continuation-compaction-e2e',
    transport: 'generic' as const,
    provider: 'test',
    model: request.sessionId.startsWith('summary:') ? 'org/summary/model' : 'work-model',
    source_input_id: request.inputId,
    attempt_index: 0,
    request_params: {
      endpoint: 'https://provider.example.test/v1/chat/completions',
      method: 'POST',
      stream: false,
      offered_tools_count: request.tools.length,
      temperature: 0,
      max_tokens: 256,
    },
    started_at: '2026-07-17T00:00:00.000Z',
    completed_at: '2026-07-17T00:00:00.001Z',
    response_status: responseStatus,
    terminal_tool_fired: null,
  };
  return status === 'ok'
    ? { ...base, status }
    : { ...base, status, error: { name: 'LlmRequestError', message: 'strict continuation context rejection', status: responseStatus } };
}
