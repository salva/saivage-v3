import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AgentAdapter, type LlmCallFn } from '../../src/agents/agent-adapter.js';
import { NotificationCenter } from '../../src/notifications/notification-center.js';

function createAdapter(tmpDir: string): AgentAdapter {
  const minimalConfig = {
    providers: {},
    models: { routes: [] },
    server: { port: 8080, host: '0.0.0.0' },
    runtime: { compactionThreshold: 0.8, maxCompactions: 3, recoveryDelayMs: 60000, maxRecoveryRetries: 0, selfCheck: { planner: 0, executor: 0, reviewer: 0, analyst: 0 } },
    security: {},
    supervisor: {},
  } as unknown as import('../../src/agents/config-schema.js').SaivageConfig;
  return new AgentAdapter({ projectRoot: tmpDir, saivageDir: join(tmpDir, '.saivage'), config: minimalConfig });
}

describe('AgentAdapter notification injection', () => {
  let tmpDir: string;
  let adapter: AgentAdapter;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'saivage-agent-notification-'));
    mkdirSync(join(tmpDir, '.saivage'), { recursive: true });
    adapter = createAdapter(tmpDir);
    jest.spyOn(adapter.router, 'resolve').mockResolvedValue([{ provider: 'test', account: 'default', model: 'fake-model' }]);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    jest.restoreAllMocks();
  });

  it('injects pending notifications into the very next model call for the actual live session', async () => {
    const llmCall = jest.fn<LlmCallFn>(async () => JSON.stringify({ card_id: 'code-1', status: 'done', status_text: 'Completed successfully', artifacts: [], attachments: [] }));
    const sessionIds: string[] = [];
    adapter.setAfterSessionCreatedHook((sessionId) => {
      sessionIds.push(sessionId);
      adapter.notificationCenter.enqueueForSession(sessionId, {
        id: 'n-1',
        kind: 'card_changed',
        severity: 'warn',
        payload_summary: 'Card changed by analyst',
        related_card_id: 'code-1',
        related_note_id: 'note-1',
        related_process_id: 'proc-1',
        related_version_seq: 7,
        source_actor: 'analyst',
        source_surface: 'web-chat',
      });
    });
    adapter.setLlmCallFn(llmCall);

    await adapter.invokeExecutor('code-1', 'goal-1', 'system prompt');

    expect(sessionIds).toHaveLength(1);
    expect(llmCall).toHaveBeenCalledTimes(1);
    const [, , messages, liveSessionId] = llmCall.mock.calls[0];
    expect(liveSessionId).toBe(sessionIds[0]);
    expect(messages[0]).toMatchObject({ role: 'user', kind: 'text' });
    expect(messages[0]?.content).toContain('## Operator updates since your last turn');
    expect(messages[0]?.content).toContain('[card_changed]');
    expect(messages[0]?.content).toContain('Card changed by analyst');
    expect(messages[0]?.content).toContain('card=code-1');
    expect(messages[0]?.content).toContain('note=note-1');
    expect(messages[0]?.content).toContain('process=proc-1');
    expect(messages[0]?.content).toContain('version=7');
    expect(messages[0]?.content).toContain('Use list_card_history/get_card_history_entry/diff_card/list_notes/get_note as needed');
    expect(adapter.notificationCenter.drainPendingForSession(liveSessionId)).toEqual([]);
  });

  it('does not reinject notifications after a successful model call marks them delivered', async () => {
    let liveSessionId = '';
    adapter.setAfterSessionCreatedHook((sessionId) => {
      liveSessionId = sessionId;
      adapter.notificationCenter.enqueueForSession(sessionId, {
        id: 'n-2',
        kind: 'card_changed',
        severity: 'warn',
        payload_summary: 'Card changed',
        related_card_id: 'code-1',
        source_actor: 'analyst',
        source_surface: 'web-chat',
      });
    });
    const llmCall = jest.fn<LlmCallFn>(async () => JSON.stringify({ card_id: 'code-1', status: 'done', status_text: 'Completed successfully', artifacts: [], attachments: [] }));
    adapter.setLlmCallFn(llmCall);

    await adapter.invokeExecutor('code-1', 'goal-1', 'system prompt');

    expect(liveSessionId).not.toBe('');
    expect(adapter.notificationCenter.drainPendingForSession(liveSessionId)).toEqual([]);
    expect(llmCall).toHaveBeenCalledTimes(1);
  });

  it('keeps pending notifications queued until a session injection drains them', async () => {
    const center = new NotificationCenter(tmpDir);
    center.enqueueForSession('sess-fail', { id: 'n-1', kind: 'card_changed', severity: 'warn', payload_summary: 'Card changed', related_card_id: 'code-1', source_actor: 'analyst', source_surface: 'web-chat' });
    expect(center.drainPendingForSession('sess-fail')).toHaveLength(1);
  });

  it('pending notifications written before call remain restart-safe on disk for same session id', () => {
    const center = new NotificationCenter(tmpDir);
    center.enqueueForSession('sess-restart', { id: 'n-9', kind: 'runtime_state', severity: 'block', payload_summary: 'Runtime paused', source_actor: 'analyst', source_surface: 'web-ui' });
    const reopened = new NotificationCenter(tmpDir);
    expect(reopened.drainPendingForSession('sess-restart').map((item) => item.payload_summary)).toEqual(['Runtime paused']);
  });
});
