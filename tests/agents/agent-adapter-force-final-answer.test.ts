import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { rmSync, mkdtempSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { AgentAdapter } from '../../src/agents/agent-adapter.js';
import { parsePlannerResult } from '../../src/agents/result-parser.js';
import { getSessionMessages } from '../../src/agents/session-persistence.js';
import { initProjectTree } from '../../src/utils/file-tree.js';
import { CardStore } from '../../src/utils/card-store.js';
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
  jest.spyOn(adapter.registry, 'isHealthy').mockReturnValue(true);
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
    const repeated = toolCallEnvelope([toolCall('call-repeat-1', 'list_notes', { cardId: 'goal-repeat' })]);
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
    expectLastAssistantPlannerEnvelope(messages, 'continue');

    const next = await adapter.invokePlanner('goal-repeat', 'system prompt');
    expect(next.status).toBe('done');
    messages = sessionMessages(tmpDir, 'goal-repeat');
    expectLastAssistantPlannerEnvelope(messages, 'done');
  });

  it('forces a parseable planner envelope after MAX_TOOL_ROUNDS exhaustion and continues on the next planner cycle', async () => {
    const adapter = createMinimalAdapter(tmpDir);
    const responses = [
      toolCallEnvelope([toolCall('call-round-1', 'list_notes', { cardId: 'goal-max', round: 1 })]),
      toolCallEnvelope([toolCall('call-round-2', 'list_notes', { cardId: 'goal-max', round: 2 })]),
      toolCallEnvelope([toolCall('call-round-3', 'list_notes', { cardId: 'goal-max', round: 3 })]),
      toolCallEnvelope([toolCall('call-round-4', 'list_notes', { cardId: 'goal-max', round: 4 })]),
      toolCallEnvelope([toolCall('call-round-5', 'list_notes', { cardId: 'goal-max', round: 5 })]),
      toolCallEnvelope([toolCall('call-round-6', 'list_notes', { cardId: 'goal-max', round: 6 })]),
      plannerEnvelope('continue', 'forced after max rounds'),
      plannerEnvelope('done', 'next planner cycle after max rounds succeeded'),
    ];
    adapter.setLlmCallFn(async () => responses.shift() ?? plannerEnvelope('done', 'fallback'));

    const recovered = await adapter.invokePlanner('goal-max', 'system prompt');
    expect(recovered).toEqual(expect.objectContaining({ status: 'continue', summary: 'forced after max rounds' }));
    expect(recovered).not.toHaveProperty('toolCalls');

    let messages = sessionMessages(tmpDir, 'goal-max');
    expect(messages.some((message) => message.kind === 'model_issue' && message.content.includes('Maximum tool-call rounds exceeded (5)'))).toBe(true);
    expect(messages.some((message) => message.kind === 'model_issue' && message.content.includes('Forcing final-answer turn without tools'))).toBe(true);
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
      status: 'continue',
      summary: 'Activated child card child-card-1; awaiting completion.',
      created_cards: [],
      updated_cards: [],
      blocked_reason: undefined,
    });
    expect(recovered).not.toHaveProperty('toolCalls');

    let messages = sessionMessages(tmpDir, 'goal-activate');
    expect(messages.some((message) => message.kind === 'model_issue' && message.content.includes('Synthesised planner continuation envelope for deferred activate_card'))).toBe(true);
    expect(messages.some((message) => message.role === 'tool' && message.tool_call_id === 'call-activate-only')).toBe(false);
    expectLastAssistantPlannerEnvelope(messages, 'continue');

    const next = await adapter.invokePlanner('goal-activate', 'system prompt');
    expect(next.status).toBe('done');
    messages = sessionMessages(tmpDir, 'goal-activate');
    expectLastAssistantPlannerEnvelope(messages, 'done');
  });
});
