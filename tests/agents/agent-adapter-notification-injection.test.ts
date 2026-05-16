import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AgentAdapter, type LlmCallFn } from '../../src/agents/agent-adapter.js';
import { NotificationCenter } from '../../src/utils/notification-center.js';

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

  it('successful model call clears notifications that were pending before the call safe point', async () => {
    const center = new NotificationCenter(tmpDir);
    center.enqueueForSession('sess-safe-point', { id: 'n-1', kind: 'card_changed', severity: 'warn', payload_summary: 'Card changed', related_card_id: 'code-1', source_actor: 'analyst', source_surface: 'web-chat' });
    const llmCall: LlmCallFn = async () => JSON.stringify({ card_id: 'code-1', status: 'done', artifacts: [], attachments: [] });
    adapter.setLlmCallFn(jest.fn(llmCall));
    center.markDeliveredForSession('sess-safe-point', ['n-1']);
    expect(center.drainPendingForSession('sess-safe-point')).toEqual([]);
  });

  it('failed model call leaves notifications pending for redelivery on a later call', async () => {
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
