import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { AgentAdapter } from '../../src/agents/agent-adapter.js';
import { getSession, getSessionMessages, listSessions } from '../../src/agents/session-persistence.js';

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

  return new AgentAdapter({
    projectRoot: tmpDir,
    saivageDir: join(tmpDir, '.saivage'),
    config: minimalConfig,
  });
}

describe('AgentAdapter executor fallback integration', () => {
  let tmpDir: string;
  let adapter: AgentAdapter;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'saivage-executor-fallback-'));
    mkdirSync(join(tmpDir, '.saivage'), { recursive: true });
    adapter = createMinimalAdapter(tmpDir);
    jest.spyOn(adapter.router, 'resolve').mockResolvedValue([
      { provider: 'test', account: 'default', model: 'fake-model' },
    ]);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    jest.restoreAllMocks();
  });

  it('uses fallback after malformed final executor JSON and marks the session failed with preserved evidence', async () => {
    const llmCallFn = jest.fn<import('../../src/agents/agent-adapter.js').LlmCallFn>()
      .mockResolvedValueOnce(JSON.stringify({
        toolCalls: [
          {
            id: 'call-write',
            type: 'function',
            function: {
              name: 'write_project_file',
              arguments: JSON.stringify({ path: 'generated/output.txt', content: 'hello\n' }),
            },
          },
          {
            id: 'call-cmd',
            type: 'function',
            function: {
              name: 'run_project_command',
              arguments: JSON.stringify({ command: 'printf verified', timeoutMs: 30000 }),
            },
          },
        ],
      }))
      .mockResolvedValueOnce(JSON.stringify({
        card_id: 'code-1',
        summary: 'tool work completed but status missing',
        result: { partial: true },
      }));

    adapter.setLlmCallFn(llmCallFn);

    const result = await adapter.invokeExecutor('code-1', 'goal-1', 'executor prompt');

    expect(result.status).toBe('failed');
    expect(result.card_id).toBe('code-1');
    expect(result.artifacts).toEqual([]);
    expect(result.attachments).toEqual([]);
    expect(result.result?.generated_files).toEqual(['generated/output.txt']);
    expect(result.result?.artifact_paths).toEqual([]);
    expect(result.result?.verification_commands).toEqual([
      expect.objectContaining({
        process_id: expect.any(String),
        status: 'exited',
        exit_code: 0,
        timed_out: false,
      }),
    ]);
    expect(result.result?.parse_failure).toEqual(expect.objectContaining({
      raw_response: expect.stringContaining('tool work completed but status missing'),
    }));
    expect(readFileSync(join(tmpDir, 'generated', 'output.txt'), 'utf8')).toBe('hello\n');

    const [sessionId] = listSessions(join(tmpDir, '.saivage'));
    expect(sessionId).toBeDefined();
    expect(getSession(join(tmpDir, '.saivage'), sessionId)!.status).toBe('failed');
    const messages = getSessionMessages(join(tmpDir, '.saivage'), sessionId);
    expect(messages.some((message) => message.kind === 'tool_result' && message.tool === 'write_project_file')).toBe(true);
    expect(messages.some((message) => message.kind === 'tool_result' && message.tool === 'run_project_command')).toBe(true);
    expect(messages.some((message) => message.kind === 'model_issue' && message.content.includes('Executor result fallback constructed after parse failure'))).toBe(true);
  });
});
