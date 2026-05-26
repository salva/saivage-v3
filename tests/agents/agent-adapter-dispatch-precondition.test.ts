import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { AgentAdapter, type LlmCallFn } from '../../src/agents/agent-adapter.js';
import { createSession, DuplicateActiveSessionError, listSessions } from '../../src/agents/session-persistence.js';

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

  return new AgentAdapter({ projectRoot: tmpDir, saivageDir: join(tmpDir, '.saivage'), config: minimalConfig });
}

describe('AgentAdapter worker dispatch precondition', () => {
  let tmpDir: string;
  let adapter: AgentAdapter;
  let llmCallFn: jest.MockedFunction<LlmCallFn>;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'saivage-agent-precondition-'));
    mkdirSync(join(tmpDir, '.saivage'), { recursive: true });
    adapter = createMinimalAdapter(tmpDir);
    jest.spyOn(adapter.router, 'resolve').mockResolvedValue([{ provider: 'test', account: 'default', model: 'fake-model' }]);
    llmCallFn = jest.fn<LlmCallFn>().mockResolvedValue(JSON.stringify({
      card_id: 'card-X',
      status: 'done',
      status_text: 'completed',
      artifacts: [],
      attachments: [],
    }));
    adapter.setLlmCallFn(llmCallFn);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    jest.restoreAllMocks();
  });

  it('rejects a duplicate active executor before LLM call or new manifest creation', async () => {
    const saivageDir = join(tmpDir, '.saivage');
    createSession(saivageDir, 'executor', 'goal-1', 'card-X');
    const before = listSessions(saivageDir);

    await expect(adapter.invokeExecutor('card-X', 'goal-1', 'prompt')).rejects.toThrow(DuplicateActiveSessionError);

    expect(llmCallFn).not.toHaveBeenCalled();
    expect(listSessions(saivageDir).sort()).toEqual(before.sort());
  });

  it('rejects a duplicate active reviewer before LLM call or new manifest creation', async () => {
    const saivageDir = join(tmpDir, '.saivage');
    createSession(saivageDir, 'reviewer', 'goal-1', 'goal-1');
    const before = listSessions(saivageDir);

    await expect(adapter.invokeReviewer('goal-1', 'prompt')).rejects.toThrow(DuplicateActiveSessionError);

    expect(llmCallFn).not.toHaveBeenCalled();
    expect(listSessions(saivageDir).sort()).toEqual(before.sort());
  });

  it('allows non-conflicting executor dispatch and creates one session', async () => {
    const result = await adapter.invokeExecutor('card-X', 'goal-1', 'prompt');

    expect(result.status).toBe('done');
    expect(llmCallFn).toHaveBeenCalledTimes(1);
    expect(listSessions(join(tmpDir, '.saivage'))).toHaveLength(1);
  });
});
