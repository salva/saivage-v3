import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { initProjectTree } from '../../src/persistence/file-tree.js';
import { Runtime } from '../../src/runtime/runtime.js';
import { NotificationCenter } from '../../src/notifications/notification-center.js';
import { releaseLock } from '../../src/runtime/lock.js';
import type { AgentRuntime } from '../../src/agents/agent-runtime.js';

describe('Runtime held dispatch for blocking notifications', () => {
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), 'saivage-runtime-held-'));
    initProjectTree(projectRoot);
  });

  afterEach(() => {
    try { releaseLock(projectRoot); } catch {}
    rmSync(projectRoot, { recursive: true, force: true });
  });

  function makeRuntime(agentRuntime: AgentRuntime): Runtime {
    return new Runtime({ projectRoot, fakeAgentConfig: { mapping: {}, fixtureDir: join(projectRoot, 'fixtures') } }, agentRuntime);
  }

  it('blocking notification prevents executor terminal acceptance until acknowledged during reinvocation', async () => {
    const center = new NotificationCenter(projectRoot);
    center.enqueueForSession('sess-executor', { id: 'n-block', kind: 'card_changed', severity: 'block', payload_summary: 'Acceptance changed', related_card_id: 'code-1', source_actor: 'analyst', source_surface: 'web-chat' });
    let reinvoked = 0;
    const agentRuntime: AgentRuntime = {
      invokePlanner() { return { status: 'done', created_cards: [], updated_cards: [] }; },
      invokeExecutor() { return { card_id: 'code-1', status: 'done', status_text: 'Completed successfully', artifacts: [], attachments: [], fallback_with_evidence: null }; },
      invokeReviewer() { return { assessment: { result: 'pass', summary: 'ok', achieved: [], issues: [], evidence_card_ids: ['code-1'] } }; },
      reinvokeSession: async () => { reinvoked += 1; center.acknowledge('sess-executor', 'n-block'); return { card_id: 'code-1', status: 'done', status_text: 'Completed successfully', artifacts: [], attachments: [], fallback_with_evidence: null }; },
      cancelSession() { return false; },
      forceCancelSession() { return false; },
      getHandoffSummary() { return null; },
      getActiveSessionHandoffs() { return []; },
    };
    const runtime = makeRuntime(agentRuntime);
    await runtime.startup();
    await expect((runtime as unknown as { enforceBlockingNotifications: (sessionId: string, role: 'executor' | 'reviewer', terminalCall: () => Promise<unknown>) => Promise<void> }).enforceBlockingNotifications('sess-executor', 'executor', async () => undefined)).resolves.toBeUndefined();
    expect(reinvoked).toBe(1);
    await runtime.shutdown();
  });

  it('second unacknowledged attempt fails with actionable error', async () => {
    const center = new NotificationCenter(projectRoot);
    center.enqueueForSession('sess-reviewer', { id: 'n-block', kind: 'note_added', severity: 'block', payload_summary: 'Escalation note added', related_note_id: 'note-1', source_actor: 'analyst', source_surface: 'web-chat' });
    const agentRuntime: AgentRuntime = {
      invokePlanner() { return { status: 'done', created_cards: [], updated_cards: [] }; },
      invokeExecutor() { return { card_id: 'code-1', status: 'done', status_text: 'Completed successfully', artifacts: [], attachments: [], fallback_with_evidence: null }; },
      invokeReviewer() { return { assessment: { result: 'pass', summary: 'ok', achieved: [], issues: [], evidence_card_ids: ['code-1'] } }; },
      reinvokeSession: async () => ({ assessment: { result: 'pass', summary: 'still unacked', achieved: [], issues: [], evidence_card_ids: ['code-1'] } }),
      cancelSession() { return false; },
      forceCancelSession() { return false; },
      getHandoffSummary() { return null; },
      getActiveSessionHandoffs() { return []; },
    };
    const runtime = makeRuntime(agentRuntime);
    await runtime.startup();
    await expect((runtime as unknown as { enforceBlockingNotifications: (sessionId: string, role: 'executor' | 'reviewer', terminalCall: () => Promise<unknown>) => Promise<void> }).enforceBlockingNotifications('sess-reviewer', 'reviewer', async () => undefined)).rejects.toThrow(/Blocking notifications remain unacknowledged/);
    await runtime.shutdown();
  });
});
