import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AnalystRuntime } from '../../src/agents/analyst-handler.js';
import { saivageConfigSchema } from '../../src/agents/config-schema.js';
import { CardService } from '../../src/cards/card-service.js';
import { EventBus } from '../../src/events/index.js';
import { appendConversationBatch, readConversation } from '../../src/persistence/conversation-file.js';
import type { LlmInvocationInput } from '../../src/runtime/actors/llm-invocation.js';
import { RuntimeInterventionBinding } from '../../src/application/intervention-readiness.js';
import { compactedConversationFixture } from '../helpers/compacted-conversation-fixture.js';
import { initProjectTree } from '../helpers/canonical-project.js';
import { testAppLogs } from '../helpers/app-logs.js';
import { createTestProcessRunner } from '../helpers/test-process-runner.js';
import { createTestPromptTemplateRegistry } from '../helpers/prompt-template-registry.js';

const roots: string[] = [];
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });

describe('Analyst compacted conversation projection', () => {
  it('rereads C1/C2 state for fresh and subsequent turns and appends each pending message once', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'saivage-analyst-compaction-'));
    roots.push(projectRoot);
    initProjectTree(projectRoot);
    const sessionId = 'analyst:global';
    const fixture = compactedConversationFixture(sessionId, true);
    appendConversationBatch(projectRoot, fixture.rows);
    const captured: LlmInvocationInput[] = [];
    const provider = { completeTurn: jest.fn(async (input: LlmInvocationInput) => {
      captured.push(input);
      if (captured.length <= 2) {
        const toolName = input.tools[captured.length - 1]!.function.name;
        return { result: { kind: 'tool_calls' as const, tool_calls: [{ id: `tool-${captured.length}`, type: 'function' as const, function: { name: toolName, arguments: '{}' } }] }, provider_exchanges: [] };
      }
      return { result: { kind: 'message' as const, content: `answer ${captured.length}` }, provider_exchanges: [] };
    }) };
    const runner = createTestProcessRunner(projectRoot);
    const eventBus = new EventBus();
    const runtime = new AnalystRuntime({
      projectRoot,
      config: saivageConfigSchema.parse({ models: { default: ['test/model'] }, providers: { test: { models: ['model'] } }, compaction: { enabled: true, input_budget_tokens: 20480, summarizer_candidate: { provider: 'test', account: null, model: 'model' } } }),
      runtimeDeps: {
        configAuthority: {}, cardStore: new CardService(projectRoot), runtime: { startProject: jest.fn(), pause: jest.fn(), resume: jest.fn(), stopProject: jest.fn(), cancelCard: jest.fn(), notifyCard: jest.fn(), getStatus: jest.fn() },
        emitAnalystToolInvoked: jest.fn(), eventBus, provider, processRunner: runner, analystProcessRootScope: runner.analystRootScope,
        conversations: { projectRoot }, appLogs: testAppLogs(projectRoot), interventionReadiness: new RuntimeInterventionBinding(),
      } as never,
      promptTemplates: createTestPromptTemplateRegistry(),
    });

    await runtime.submit('global', { userContent: 'first operator question' });
    assertLatestOnly(captured[0]!, fixture, sessionId);
    expect(captured.slice(0, 3).map((input) => input.preparedCompaction)).toEqual([undefined, undefined, undefined]);
    expect(captured.slice(0, 3).map((input) => input.modelParams.maxTokens)).toEqual([4096, 4096, 4096]);
    expect(captured[0]!.tools[0]!.function.name).not.toBe(captured[1]!.tools[1]!.function.name);
    expect(captured[0]).not.toHaveProperty('turnMessages');
    expect(countContent(captured[0]!.providerConversation.messages, 'first operator question')).toBe(1);
    expect(countContent(readConversation(projectRoot, sessionId).physicalRows, 'first operator question')).toBe(1);

    await runtime.submit('global', { userContent: 'second operator question', workspaceContext: { view: 'cards', entityId: 'project', refinement: null } });
    assertLatestOnly(captured[3]!, fixture, sessionId);
    expect(captured[3]).not.toHaveProperty('turnMessages');
    expect(countContent(captured[3]!.providerConversation.messages, 'first operator question')).toBe(1);
    expect(countContent(captured[3]!.providerConversation.messages, 'second operator question')).toBe(1);
    expect(countContent(captured[3]!.providerConversation.messages, 'answer 3')).toBe(1);
    const durable = readConversation(projectRoot, sessionId).physicalRows;
    expect(countContent(durable, 'first operator question')).toBe(1);
    expect(countContent(durable, 'second operator question')).toBe(1);
    const durablePairIndexes = fixture.privatePairIds.map((id) => durable.findIndex((row) => row.id === id));
    expect(durablePairIndexes[1]).toBe(durablePairIndexes[0]! + 1);
  });
});

function assertLatestOnly(input: LlmInvocationInput, fixture: ReturnType<typeof compactedConversationFixture>, sessionId: string): void {
  expect(input.sessionId).toBe(sessionId);
  expect(input.providerConversation.sourceSessionId).toBe(sessionId);
  const messages = input.providerConversation.messages;
  expect(messages.filter((row) => row.id.endsWith(':rendered'))).toHaveLength(1);
  expect(messages.find((row) => row.id.endsWith(':rendered'))?.content).toContain(fixture.c2Summary);
  expect(JSON.stringify(messages)).not.toContain(fixture.c1Summary);
  expect(messages.some((row) => row.kind === 'context_compaction')).toBe(false);
  for (const id of fixture.c1CoveredIds) expect(messages.some((row) => row.id === id)).toBe(false);
  expect(fixture.privatePairIds.map((id) => messages.findIndex((row) => row.id === id))).toEqual([2, 3]);
}

function countContent(rows: readonly { content: string }[], content: string): number {
  return rows.filter((row) => row.content === content).length;
}
