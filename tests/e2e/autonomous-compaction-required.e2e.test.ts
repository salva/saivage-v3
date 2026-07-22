import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { saivageConfigSchema } from '../../src/schemas/saivage-config.js';
import { DEFAULT_CARD_PROCESSES } from '../../src/agents/default-card-processes.js';
import { InvocationService, type InvocationRequest } from '../../src/agents/invocation-service.js';
import { createRuntimeApplication } from '../../src/application/runtime-composition.js';
import { CardService } from '../../src/cards/card-service.js';
import { createEventLog } from '../../src/observability/index.js';
import { appendConversationBatch, readConversation } from '../../src/persistence/conversation-file.js';
import { initProjectTree, testConfigAuthority } from '../helpers/canonical-project.js';
import { testAutonomousCompaction } from '../helpers/llm-test-helpers.js';
import { ManagedProcessGroupRegistry } from '../../src/runtime/managed-process-group-registry.js';
import { ProcessRunner } from '../../src/runtime/process-runner.js';

const roots: string[] = [];
afterEach(() => { jest.restoreAllMocks(); while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });

describe('required autonomous compaction E2E', () => {
  it('compacts a long planner history before provider admission through ordinary application composition', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'saivage-required-compaction-'));
    roots.push(projectRoot);
    initProjectTree(projectRoot);
    appendLongPlannerHistory(projectRoot);
    const requests: InvocationRequest[] = [];
    let plannerCalls = 0;
    jest.spyOn(InvocationService.prototype, 'invokeWithRecovery').mockImplementation(async (request) => {
      requests.push(request);
      if (request.role === 'analyst') return { result: { kind: 'message', content: 'concise prior work summary' }, provider_exchanges: [] };
      plannerCalls += 1;
      const call = plannerCalls === 1
        ? { id: 'write', type: 'function' as const, function: { name: 'write', arguments: JSON.stringify({ path: 'record:///status.md?v=next', content: 'blocked evidence' }) } }
        : { id: 'emit', type: 'function' as const, function: { name: 'emit_result', arguments: JSON.stringify({ outcome: 'blocked', summary: 'blocked' }) } };
      return { result: { kind: 'tool_calls', tool_calls: [call] }, provider_exchanges: [] };
    });
    const config = saivageConfigSchema.parse({
      models: { default: ['work-model'], max_tokens: { analyst: 2400 } },
      providers: { test: { models: ['work-model', 'org/summary/model'] } },
      compaction: { enabled: true, input_budget_tokens: 12000, summarizer_candidate: { provider: 'test', account: null, model: 'org/summary/model' } },
      card_processes: DEFAULT_CARD_PROCESSES,
    });
    const freshness = { runtimeChanged: jest.fn(), cardProjectionChanged: jest.fn(), agentsChanged: jest.fn(), conversationChanged: jest.fn(), timelineChanged: jest.fn() };
    const processRegistry = new ManagedProcessGroupRegistry();
    const runtimeProcessRootScope = processRegistry.createContainerScope(processRegistry.rootScope, 'runtime-cards');
    const analystProcessRootScope = processRegistry.createContainerScope(processRegistry.rootScope, 'analyst-sessions');
    const application = createRuntimeApplication({ projectRoot, processIdentity: { pid: 4242, startedAt: '2026-07-18T00:00:00.000Z' }, config, configAuthority: testConfigAuthority(projectRoot), eventLogger: createEventLog(projectRoot, freshness.timelineChanged), cardStore: new CardService(projectRoot, freshness), freshness, processRunner: new ProcessRunner(projectRoot, processRegistry), runtimeProcessRootScope, analystProcessRootScope, mcpToolInvocation: testAutonomousCompaction.mcpToolInvocation });

    await application.runtimeApi.start();
    await application.runtimeApi.startProject();
    await waitUntil(() => application.runtimeApi.getStatus().status === 'stopped');

    const conversation = readConversation(projectRoot, 'planner:project');
    expect(conversation.physicalRows.filter((row) => row.kind === 'context_compaction')).toHaveLength(1);
    expect(conversation.sourceRows.some((row) => row.id === 'history-1')).toBe(true);
    const plannerRequest = requests.find((request) => request.role === 'planner');
    expect(plannerRequest).toBeDefined();
    expect(plannerRequest!.providerConversation.messages.some((row) => row.kind === 'context_compaction')).toBe(false);
    expect(plannerRequest!.providerConversation.messages.filter((row) => row.id.endsWith(':rendered'))).toHaveLength(1);
    const summaryRequests = requests.filter((request) => request.role === 'analyst');
    expect(summaryRequests.length).toBeGreaterThan(0);
    expect(summaryRequests.every((request) => JSON.stringify(request.candidateChain) === JSON.stringify([{ provider: 'test', account: null, model: 'org/summary/model' }]))).toBe(true);
    expect(summaryRequests.every((request) => !request.systemPrompt.includes('org/summary/model') && !('model_spec' in request))).toBe(true);
  });
});

function appendLongPlannerHistory(projectRoot: string): void {
  const rows = Array.from({ length: 12 }, (_, index) => {
    const ordinal = index + 1;
    const inputId = `00000000-0000-4000-8000-${String(ordinal).padStart(12, '0')}`;
    const timestamp = `2026-07-17T00:00:${String(ordinal).padStart(2, '0')}.000Z`;
    return [
      { id: `activation-${ordinal}`, session_id: 'planner:project' as const, role: 'system' as const, kind: 'activity' as const, content: JSON.stringify({ event: 'activation_open', role: 'planner', card_id: 'project', input_id: inputId, timestamp }), round_id: `r-pre-${String(ordinal).padStart(32, '0')}`, message_index: 0, block_index: 0, timestamp },
      { id: `history-${ordinal}`, session_id: 'planner:project' as const, role: 'user' as const, kind: 'text' as const, content: `${ordinal}:${'x'.repeat(4000)}`, round_id: `r-user-${String(ordinal).padStart(32, '0')}`, message_index: 1, block_index: 0, timestamp },
    ];
  }).flat();
  appendConversationBatch({ projectRoot }, rows);
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 1000; attempt += 1) { if (predicate()) return; await new Promise((resolve) => setTimeout(resolve, 2)); }
  throw new Error('runtime did not settle');
}
