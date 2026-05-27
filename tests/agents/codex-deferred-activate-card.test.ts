import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { rmSync, mkdtempSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { AgentAdapter } from '../../src/agents/agent-adapter.js';
import { codexMessages } from '../../src/agents/llm-openai-codex-gateway.js';
import { createSession, getSessionMessages } from '../../src/agents/session-persistence.js';
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

  return new AgentAdapter({
    projectRoot: tmpDir,
    saivageDir: join(tmpDir, '.saivage'),
    config: minimalConfig,
  });
}


function createTestCard(tmpDir: string, id: string, parent = 'project') {
  const store = new CardStore(tmpDir);
  if (parent !== 'project' && !store.read(parent)) store.create({ id: parent, type: 'goal', parent: 'project', depth: 1, title: parent, description: parent, status: 'running', depends_on: [], priority: 1, tags: [], urgency: 'normal', created_by: 'planner', blocks: [], related: [], acceptance: '', artifacts: [], attachments: [], retries: 0 });
  store.create({ id, type: 'code', parent, depth: parent === 'project' ? 1 : 2, title: id, description: id, status: 'backlog', depends_on: [], priority: 1, tags: [], urgency: 'normal', created_by: 'planner', blocks: [], related: [], acceptance: '', artifacts: [], attachments: [], retries: 0 });
}

describe('Codex deferred activate_card history assembly', () => {
  let tmpDir: string;
  let adapter: AgentAdapter;
  const sessionId = 'planner:goal-stage-18';

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'saivage-codex-deferred-activate-'));
    mkdirSync(join(tmpDir, '.saivage'), { recursive: true });
    initProjectTree(tmpDir);
    adapter = createMinimalAdapter(tmpDir);
    createSession(join(tmpDir, '.saivage'), 'planner', 'goal-stage-18', 'goal-stage-18', 'codex-test-model', sessionId);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('keeps deferred activate_card tool result history for the next planner cycle while preserving the executed sibling pair', async () => {
    createTestCard(tmpDir, 'child-card-1', 'goal-stage-18');
    let followUpMessages: AgentMessage[] = [];
    adapter.setLlmCallFn(async (_candidate, _systemPrompt, messages) => {
      followUpMessages = messages;
      return JSON.stringify({ status: 'continue', summary: 'follow-up completed' });
    });

    const activateArgs = JSON.stringify({ cardId: 'child-card-1' });
    const reportArgs = JSON.stringify({ summary: 'synthetic progress' });
    const rawResponse = JSON.stringify({
      toolCalls: [
        { id: 'call_activate_stage_18', type: 'function', function: { name: 'activate_card', arguments: activateArgs } },
        { id: 'call_report_progress_stage_18', type: 'function', function: { name: 'report_progress', arguments: reportArgs } },
      ],
    });

    await (adapter as any).handleToolCallsLoop(
      rawResponse,
      'planner',
      sessionId,
      { provider: 'openai-codex', account: null, model: 'gpt-5.4' },
      'system prompt',
      { temperature: 0.1, maxTokens: 256 },
      new AbortController(),
      { goalId: 'goal-stage-18', cardId: 'goal-stage-18' },
    );

    const persisted = getSessionMessages(join(tmpDir, '.saivage'), sessionId);
    const assistantToolRows = persisted.filter((message) => message.role === 'assistant' && message.kind === 'tool_call');
    expect(assistantToolRows).toHaveLength(2);
    expect(assistantToolRows.map((message) => message.tool)).toEqual(['activate_card', 'report_progress']);
    expect(assistantToolRows.map((message) => JSON.parse(message.content).toolCalls)).toEqual([
      [expect.objectContaining({ id: 'call_activate_stage_18' })],
      [expect.objectContaining({ id: 'call_report_progress_stage_18' })],
    ]);

    expect(persisted.some((message) => message.role === 'tool' && message.tool_call_id === 'call_activate_stage_18')).toBe(true);
    expect(persisted.some((message) => message.role === 'tool' && message.tool_call_id === 'call_report_progress_stage_18')).toBe(true);
    expect(followUpMessages.map((message) => message.id)).toEqual(persisted.map((message) => message.id));

    const codexInput = codexMessages(followUpMessages);
    expect(codexInput).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'function_call_output', call_id: 'call_activate_stage_18' }),
    ]));
    expect(codexInput).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'function_call', call_id: 'call_report_progress_stage_18', name: 'report_progress', arguments: reportArgs }),
      expect.objectContaining({ type: 'function_call_output', call_id: 'call_report_progress_stage_18' }),
    ]));
  });
});
