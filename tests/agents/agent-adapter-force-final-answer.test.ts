import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { rmSync, mkdtempSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { AgentAdapter } from '../../src/agents/agent-adapter.js';
import { parsePlannerResult } from '../../src/agents/result-parser.js';
import { getSessionMessages } from '../../src/agents/session-persistence.js';
import { initProjectTree } from '../../src/persistence/file-tree.js';
import { CardStore } from '../../src/cards/card-store.js';
import type { AgentMessage } from '../../src/schemas/types.js';

function createMinimalAdapter(tmpDir: string): AgentAdapter {
  const minimalConfig = {
    providers: {},
    models: { routes: [] },
    server: { port: 8080, host: '0.0.0.0' },
    runtime: {
      compactionThreshold: 0.8,
      maxCompactions: 3,
      recoveryDelayMs: 60000,
      maxRecoveryRetries: 3,
      selfCheck: { planner: 0, executor: 0, reviewer: 0, analyst: 0 },
    },
    security: {},
    supervisor: {},
  } as unknown as import('../../src/agents/config-schema.js').SaivageConfig;

  const adapter = new AgentAdapter({
    projectRoot: tmpDir,
    saivageDir: join(tmpDir, '.saivage'),
    config: minimalConfig,
  });
  jest.spyOn(adapter.router, 'resolve').mockResolvedValue([{ provider: 'test-provider', account: null, model: 'test-model' }]);
  jest.spyOn(adapter.candidateAvailability, 'isAvailable').mockReturnValue(true);
  return adapter;
}

function plannerEnvelope(status: 'continue' | 'done' = 'continue', summary = 'planner recovered') {
  return JSON.stringify({ status, summary, created_cards: [], updated_cards: [] });
}

function toolCall(id: string, name: string, args: Record<string, unknown> = {}) {
  return {
    id,
    type: 'function',
    function: { name, arguments: JSON.stringify(args) },
  };
}

function toolCallEnvelope(calls: Array<ReturnType<typeof toolCall>>) {
  return JSON.stringify({ toolCalls: calls });
}

function sessionMessages(tmpDir: string, goalId: string): AgentMessage[] {
  return getSessionMessages(join(tmpDir, '.saivage'), `planner:${goalId}`);
}

function assistantTextMessages(messages: AgentMessage[]): AgentMessage[] {
  return messages.filter((message) => message.role === 'assistant' && message.kind === 'text');
}


function expectModelIssuesDoNotContainSyntheticSecrets(messages: AgentMessage[]): void {
  const modelIssues = messages.filter((message) => message.kind === 'model_issue');
  expect(modelIssues.length).toBeGreaterThan(0);
  const persisted = modelIssues.map((message) => message.content).join('\n');
  expect(persisted).not.toContain('SYNTHETIC_PROVIDER_TOKEN');
  expect(persisted).not.toContain('SYNTHETIC_ACCESS');
  expect(persisted).not.toContain('SYNTHETIC_INLINE');
  expect(persisted).not.toContain('SYNTHETIC_QUERY');
}

function expectLastAssistantPlannerEnvelope(messages: AgentMessage[], expectedStatus: 'continue' | 'done') {
  const assistantTexts = assistantTextMessages(messages);
  expect(assistantTexts.length).toBeGreaterThan(0);
  const raw = assistantTexts.at(-1)!.content;
  expect(() => parsePlannerResult(raw)).not.toThrow();
  expect(JSON.parse(raw)).not.toHaveProperty('toolCalls');
  expect(parsePlannerResult(raw).status).toBe(expectedStatus);
}


function createTestCard(tmpDir: string, id: string, parent = 'project') {
  const store = new CardStore(tmpDir);
  if (parent !== 'project' && !store.read(parent)) store.create({ id: parent, type: 'goal', parent: 'project', depth: 1, title: parent, description: parent, status: 'running', depends_on: [], priority: 1, tags: [], urgency: 'normal', created_by: 'planner', blocks: [], related: [], acceptance: '', artifacts: [], attachments: [], retries: 0 });
  store.create({ id, type: 'code', parent, depth: parent === 'project' ? 1 : 2, title: id, description: id, status: 'backlog', depends_on: [], priority: 1, tags: [], urgency: 'normal', created_by: 'planner', blocks: [], related: [], acceptance: '', artifacts: [], attachments: [], retries: 0 });
}

describe('AgentAdapter forceFinalAnswer planner recovery', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'saivage-force-final-answer-'));
    mkdirSync(join(tmpDir, '.saivage'), { recursive: true });
    initProjectTree(tmpDir);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('forces a parseable planner envelope after a repeated tool-call fingerprint and continues on the next planner cycle', async () => {
    const adapter = createMinimalAdapter(tmpDir);
    const repeated = toolCallEnvelope([toolCall('call-repeat-1', '__synthetic_repeat_tool', { cardId: 'goal-repeat', token: 'SYNTHETIC_PROVIDER_TOKEN', access_token: 'SYNTHETIC_ACCESS' })]);
    const responses = [
      repeated,
      repeated,
      plannerEnvelope('continue', 'forced after repeated fingerprint'),
      plannerEnvelope('done', 'next planner cycle succeeded'),
    ];
    adapter.setLlmCallFn(async () => responses.shift() ?? plannerEnvelope('done', 'fallback'));

    const recovered = await adapter.invokePlanner('goal-repeat', 'system prompt');
    expect(recovered).toEqual(expect.objectContaining({ status: 'continue', summary: 'forced after repeated fingerprint' }));
    expect(recovered).not.toHaveProperty('toolCalls');

    let messages = sessionMessages(tmpDir, 'goal-repeat');
    expect(messages.some((message) => message.kind === 'model_issue' && message.content.includes('Repeated tool-call fingerprint detected'))).toBe(true);
    expect(messages.some((message) => message.kind === 'model_issue' && message.content.includes('Forcing final-answer turn without tools'))).toBe(true);
    expectModelIssuesDoNotContainSyntheticSecrets(messages);
    expectLastAssistantPlannerEnvelope(messages, 'continue');

    const next = await adapter.invokePlanner('goal-repeat', 'system prompt');
    expect(next.status).toBe('done');
    messages = sessionMessages(tmpDir, 'goal-repeat');
    expectLastAssistantPlannerEnvelope(messages, 'done');
  });

  it('continues through more than the former max tool rounds and accepts the eventual planner envelope', async () => {
    const adapter = createMinimalAdapter(tmpDir);
    const responses = [
      toolCallEnvelope([toolCall('call-round-1', '__synthetic_repeat_tool', { cardId: 'goal-max', round: 1 })]),
      toolCallEnvelope([toolCall('call-round-2', '__synthetic_repeat_tool', { cardId: 'goal-max', round: 2 })]),
      toolCallEnvelope([toolCall('call-round-3', '__synthetic_repeat_tool', { cardId: 'goal-max', round: 3 })]),
      toolCallEnvelope([toolCall('call-round-4', '__synthetic_repeat_tool', { cardId: 'goal-max', round: 4 })]),
      toolCallEnvelope([toolCall('call-round-5', '__synthetic_repeat_tool', { cardId: 'goal-max', round: 5 })]),
      toolCallEnvelope([toolCall('call-round-6', '__synthetic_repeat_tool', { cardId: 'goal-max', round: 6 })]),
      plannerEnvelope('continue', 'continued after many tool rounds'),
      plannerEnvelope('done', 'next planner cycle after many tool rounds succeeded'),
    ];
    adapter.setLlmCallFn(async () => responses.shift() ?? plannerEnvelope('done', 'fallback'));

    const recovered = await adapter.invokePlanner('goal-max', 'system prompt');
    expect(recovered).toEqual(expect.objectContaining({ status: 'continue', summary: 'continued after many tool rounds' }));
    expect(recovered).not.toHaveProperty('toolCalls');

    let messages = sessionMessages(tmpDir, 'goal-max');
    expect(messages.some((message) => message.kind === 'model_issue' && message.content.includes('Maximum tool-call rounds exceeded'))).toBe(false);
    expect(messages.some((message) => message.kind === 'model_issue' && message.content.includes('Forcing final-answer turn without tools'))).toBe(false);
    expectLastAssistantPlannerEnvelope(messages, 'continue');

    const next = await adapter.invokePlanner('goal-max', 'system prompt');
    expect(next.status).toBe('done');
    messages = sessionMessages(tmpDir, 'goal-max');
    expectLastAssistantPlannerEnvelope(messages, 'done');
  });

  it('synthesizes a parseable continuation for activate_card-only deferred output and continues on the next planner cycle', async () => {
    const adapter = createMinimalAdapter(tmpDir);
    createTestCard(tmpDir, 'child-card-1', 'goal-activate');
    const responses = [
      toolCallEnvelope([toolCall('call-activate-only', 'activate_card', { card_id: 'child-card-1', cardId: 'child-card-1' })]),
      plannerEnvelope('done', 'next planner cycle after deferred activation succeeded'),
    ];
    adapter.setLlmCallFn(async () => responses.shift() ?? plannerEnvelope('done', 'fallback'));

    const recovered = await adapter.invokePlanner('goal-activate', 'system prompt');
    expect(recovered).toEqual({
      status: 'done',
      summary: 'next planner cycle after deferred activation succeeded',
      created_cards: [],
      updated_cards: [],
      blocked_reason: undefined,
    });
    expect(recovered).not.toHaveProperty('toolCalls');

    let messages = sessionMessages(tmpDir, 'goal-activate');
    expect(messages.some((message) => message.kind === 'model_issue' && message.content.includes('Synthesised planner continuation envelope for deferred activate_card'))).toBe(false);
    expect(messages.some((message) => message.role === 'tool' && message.tool_call_id === 'call-activate-only')).toBe(true);
    expectLastAssistantPlannerEnvelope(messages, 'done');

    const next = await adapter.invokePlanner('goal-activate', 'system prompt');
    expect(next.status).toBe('done');
    messages = sessionMessages(tmpDir, 'goal-activate');
    expectLastAssistantPlannerEnvelope(messages, 'done');
  });

  it('redacts persisted model_issue content when forceFinalAnswer fails with provider secrets', async () => {
    const adapter = createMinimalAdapter(tmpDir);
    adapter.runtimeConfig.recoveryDelayMs = 0;
    adapter.runtimeConfig.maxRecoveryRetries = 0;
    const repeated = toolCallEnvelope([toolCall('call-repeat-secret', '__synthetic_repeat_tool', { cardId: 'goal-force-fail', token: 'SYNTHETIC_PROVIDER_TOKEN' })]);
    const responses = [repeated, repeated];
    adapter.setLlmCallFn(async () => {
      const next = responses.shift();
      if (next) return next;
      throw new Error('forced call failed with Bearer SYNTHETIC_PROVIDER_TOKEN {"access_token":"SYNTHETIC_ACCESS"}');
    });

    await expect(adapter.invokePlanner('goal-force-fail', 'system prompt')).rejects.toThrow();

    const messages = sessionMessages(tmpDir, 'goal-force-fail');
    expect(messages.some((message) => message.kind === 'model_issue' && message.content.includes('forceFinalAnswer LLM call failed'))).toBe(true);
    expectModelIssuesDoNotContainSyntheticSecrets(messages);
  });

  it('redacts persisted model_issue content from invocation recovery decisions', async () => {
    const adapter = createMinimalAdapter(tmpDir);
    adapter.runtimeConfig.recoveryDelayMs = 0;
    adapter.runtimeConfig.maxRecoveryRetries = 1;
    const responses = [
      'not json Bearer SYNTHETIC_PROVIDER_TOKEN {"access_token":"SYNTHETIC_ACCESS"}',
      plannerEnvelope('done', 'recovered after parse failure'),
    ];
    adapter.setLlmCallFn(async () => responses.shift() ?? plannerEnvelope('done', 'fallback'));

    const result = await adapter.invokePlanner('goal-recovery-redaction', 'system prompt');
    expect(result.status).toBe('done');

    const messages = sessionMessages(tmpDir, 'goal-recovery-redaction');
    expect(messages.some((message) => message.kind === 'model_issue' && message.content.includes('invalid response contract'))).toBe(true);
    expectModelIssuesDoNotContainSyntheticSecrets(messages);
  });

});
