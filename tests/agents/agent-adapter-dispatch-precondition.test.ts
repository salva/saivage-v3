import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { AgentAdapter } from '../../src/agents/agent-adapter.js';
import type { LlmCallFn } from '../../src/agents/llm-contracts.js';
import { createSession, ConcurrentAgentSessionError, getSession, listSessions, markSessionWaiting } from '../../src/agents/session-persistence.js';
import { CardStore } from '../../src/cards/card-store.js';

function createMinimalAdapter(tmpDir: string): AgentAdapter {
  const minimalConfig = {
    providers: {},
    models: { routes: [] },
    server: { port: 8080, host: '0.0.0.0' },
    runtime: {
      compactionThreshold: 0.8,
      maxCompactions: 3,
      recoveryDelayMs: 60000,
      maxRecoveryRetries: 1,
      selfCheck: { planner: 0, executor: 0, reviewer: 0, analyst: 0 },
    },
    security: {},
    supervisor: {},
  } as unknown as import('../../src/agents/config-schema.js').SaivageConfig;

  return new AgentAdapter({ projectRoot: tmpDir, saivageDir: join(tmpDir, '.saivage'), config: minimalConfig, cardStore: new CardStore(tmpDir) });
}

describe('AgentAdapter dispatch precondition', () => {
  let tmpDir: string;
  let adapter: AgentAdapter;
  let llmCallFn: jest.MockedFunction<LlmCallFn>;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'saivage-agent-precondition-'));
    mkdirSync(join(tmpDir, '.saivage'), { recursive: true });
    adapter = createMinimalAdapter(tmpDir);
    jest.spyOn(adapter.router, 'resolve').mockResolvedValue([{ provider: 'test', account: 'default', model: 'fake-model' }]);
    llmCallFn = jest.fn<LlmCallFn>().mockImplementation(async (_candidate, _systemPrompt, _messages, sessionId) => {
      if (sessionId.startsWith('planner:')) {
        return {
          kind: 'tool_calls',
          tool_calls: [{ id: 'c1', type: 'function', function: { name: 'emit_planner_result', arguments: JSON.stringify({ status: 'done', summary: 'done' }) } }],
        };
      }
      return {
        kind: 'tool_calls',
        tool_calls: [{ id: 'c2', type: 'function', function: { name: 'emit_executor_result', arguments: JSON.stringify({ card_id: 'card-X', status: 'done', status_text: 'completed', artifacts: [], attachments: [] }) } }],
      };
    });
    adapter.setLlmCallFn(llmCallFn);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    jest.restoreAllMocks();
  });

  it('rejects new executor when an active executor exists on a different card', async () => {
    const saivageDir = join(tmpDir, '.saivage');
    createSession(saivageDir, 'executor', 'goal-1', 'card-A');
    const before = listSessions(saivageDir);

    await expect(adapter.invokeExecutor('card-B', 'goal-1', 'prompt')).rejects.toThrow(ConcurrentAgentSessionError);

    expect(llmCallFn).not.toHaveBeenCalled();
    expect(listSessions(saivageDir).sort()).toEqual(before.sort());
  });

  it('rejects new executor when an active planner exists', async () => {
    const saivageDir = join(tmpDir, '.saivage');
    createSession(saivageDir, 'planner', 'goal-1', 'goal-1');
    const before = listSessions(saivageDir);

    await expect(adapter.invokeExecutor('card-B', 'goal-1', 'prompt')).rejects.toThrow(ConcurrentAgentSessionError);

    expect(llmCallFn).not.toHaveBeenCalled();
    expect(listSessions(saivageDir).sort()).toEqual(before.sort());
  });

  it('rejects new reviewer when an active executor exists (cross-role)', async () => {
    const saivageDir = join(tmpDir, '.saivage');
    createSession(saivageDir, 'executor', 'goal-1', 'card-A');
    const before = listSessions(saivageDir);

    await expect(adapter.invokeReviewer('goal-1', 'prompt')).rejects.toThrow(ConcurrentAgentSessionError);

    expect(llmCallFn).not.toHaveBeenCalled();
    expect(listSessions(saivageDir).sort()).toEqual(before.sort());
  });

  it('allows planner deterministic-ID re-entry from waiting', async () => {
    const saivageDir = join(tmpDir, '.saivage');
    createSession(saivageDir, 'planner', 'goal-1', 'goal-1');
    markSessionWaiting(saivageDir, 'planner:goal-1');

    const result = await adapter.invokePlanner('goal-1', 'systemPrompt', []);

    expect(result.status).toBe('done');
    expect(getSession(saivageDir, 'planner:goal-1')?.status).toBe('done');
    expect(llmCallFn).toHaveBeenCalledTimes(1);
  });

  it('does not block executor dispatch when only an active analyst exists', async () => {
    const saivageDir = join(tmpDir, '.saivage');
    createSession(saivageDir, 'analyst');

    const result = await adapter.invokeExecutor('card-X', 'goal-1', 'prompt');

    expect(result.status).toBe('done');
    expect(llmCallFn).toHaveBeenCalledTimes(1);
    expect(listSessions(saivageDir)).toHaveLength(2);
  });

  it('allows non-conflicting executor dispatch and creates one session', async () => {
    const result = await adapter.invokeExecutor('card-X', 'goal-1', 'prompt');

    expect(result.status).toBe('done');
    expect(llmCallFn).toHaveBeenCalledTimes(1);
    expect(listSessions(join(tmpDir, '.saivage'))).toHaveLength(1);
  });
});
