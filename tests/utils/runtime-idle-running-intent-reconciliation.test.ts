import { describe, it, expect, afterEach } from '@jest/globals';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { initProjectTree } from '../../src/persistence/file-tree.js';
import { CardStore } from '../../src/cards/card-store.js';
import {
  appendRuntimeRun,
  initRuntimeState,
  readRuntimeState,
  saveRuntimeState,
} from '../../src/runtime/state.js';
import { releaseLock } from '../../src/runtime/lock.js';
import { FakeAgentAdapter } from '../../src/agents/fake-agent.js';
import { createRuntimeCoreTestContainer, type RuntimeCoreTestContainer } from '../../src/runtime/core-composition.js';

let root: string | null = null;
let harness: RuntimeCoreTestContainer | null = null;

afterEach(async () => {
  if (harness) {
    try {
      await harness.api.shutdown();
    } catch {
      // ignore cleanup failures in temp projects
    }
    harness = null;
  }
  if (root) {
    try {
      releaseLock(root);
    } catch {
      // ignore
    }
    rmSync(root, { recursive: true, force: true });
    root = null;
  }
});

describe('Runtime stale running-intent reconciliation', () => {
  it('reconciles an open root run and preserves running intent for redispatch', async () => {
    root = mkdtempSync(join(tmpdir(), 'saivage-idle-running-intent-'));
    initProjectTree(root);
    const cards = new CardStore(root);
    cards.repairTerminalLifecycle('project', {
      status: 'done',
      lifecycle: { status: 'done', result: { kind: 'planner_done', created_cards: [], updated_cards: [], summary: 'terminal project' }, error: null, completed_at: '2026-01-01T00:00:00.000Z' },
    });
    cards.update('project', { status_text: 'project terminal for stale-intent regression' });

    const base = initRuntimeState(root);
    const rootRun = appendRuntimeRun(root, {
      run_id: 'root-run-open-after-terminal-project',
      kind: 'root',
      card_id: 'project',
      parent_run_id: null,
      command_id: 'cmd-start-project',
      activation_id: null,
      phase: 'planner',
      runtime_status: 'running',
      session_id: 'planner:project',
    });
    saveRuntimeState(root, {
      ...(readRuntimeState(root) ?? base),
      status: 'idle',
      current_card_id: null,
      current_agent_session_id: null,
      active_card_run: null,
      runtime_intent: {
        status: 'running',
        updated_at: new Date().toISOString(),
        source_command_id: 'cmd-start-project',
        reason: 'stale persisted running intent',
      },
    });

    const fakeAgent = new FakeAgentAdapter({
      mapping: { project: 'missing-fixture-should-not-dispatch' },
      fixtureDir: root,
    });
    const dispatched: string[] = [];
    harness = createRuntimeCoreTestContainer({
      config: { projectRoot: root, fakeAgentConfig: { mapping: { project: 'missing-fixture-should-not-dispatch' }, fixtureDir: root }, autoDispatchBacklog: false },
      agentRuntime: fakeAgent,
      goalDispatcher: async (goalId) => { dispatched.push(goalId); },
    });

    await harness.api.start();
    await new Promise<void>((resolve, reject) => {
      const deadline = Date.now() + 2000;
      const poll = () => {
        if (dispatched.length > 0 && harness?.diagnosticTestTools.getBackgroundDispatchCount() === 0) return resolve();
        if (Date.now() >= deadline) return reject(new Error('startup did not redispatch running intent'));
        setTimeout(poll, 10);
      };
      poll();
    });

    const reconciled = readRuntimeState(root);
    expect(dispatched).toEqual(['project']);
    expect(reconciled?.runtime_intent?.status).toBe('running');
    const reconciledRun = (reconciled?.runtime_runs ?? []).find((run) => run.run_id === rootRun.run_id);
    expect(reconciledRun?.phase).toBe('completed');
    expect(reconciledRun?.runtime_status).toBe('idle');
    expect(reconciledRun?.outcome).toEqual(expect.objectContaining({ kind: 'completed', result: 'done' }));
    expect(reconciledRun?.finished_at).toBeTruthy();
    expect(harness.diagnosticTestTools.getBackgroundDispatchCount()).toBe(0);
  });

  it('stops expected-idle intent when all root runs are already closed and project is terminal', async () => {
    root = mkdtempSync(join(tmpdir(), 'saivage-idle-running-intent-closed-'));
    initProjectTree(root);
    const cards = new CardStore(root);
    cards.repairTerminalLifecycle('project', {
      status: 'done',
      lifecycle: { status: 'done', result: { kind: 'planner_done', created_cards: [], updated_cards: [], summary: 'terminal project' }, error: null, completed_at: '2026-01-01T00:00:00.000Z' },
    });
    cards.update('project', { status_text: 'project terminal with closed root runs' });

    const base = initRuntimeState(root);
    appendRuntimeRun(root, {
      run_id: 'root-run-already-completed',
      kind: 'root',
      card_id: 'project',
      parent_run_id: null,
      command_id: 'cmd-start-project',
      activation_id: null,
      phase: 'completed',
      runtime_status: 'idle',
      session_id: 'planner:project',
      finished_at: new Date().toISOString(),
      outcome: { kind: 'completed', result: 'done', finished_at: new Date().toISOString() },
    });
    saveRuntimeState(root, {
      ...(readRuntimeState(root) ?? base),
      status: 'idle',
      current_card_id: null,
      current_agent_session_id: null,
      active_card_run: null,
      runtime_intent: {
        status: 'running',
        updated_at: new Date().toISOString(),
        source_command_id: 'cmd-start-project',
        reason: 'stale persisted running intent after all root runs closed',
      },
    });

    const fakeAgent = new FakeAgentAdapter({
      mapping: { project: 'missing-fixture-should-not-dispatch' },
      fixtureDir: root,
    });
    harness = createRuntimeCoreTestContainer({
      config: { projectRoot: root, fakeAgentConfig: { mapping: { project: 'missing-fixture-should-not-dispatch' }, fixtureDir: root }, autoDispatchBacklog: false },
      agentRuntime: fakeAgent,
    });

    await harness.api.start();

    const reconciled = readRuntimeState(root);
    expect(reconciled?.status).toBe('idle');
    expect(reconciled?.current_card_id).toBeNull();
    expect(reconciled?.active_card_run).toBeNull();
    expect(reconciled?.runtime_intent?.status).toBe('stopped');
    expect(reconciled?.runtime_intent?.reason).toContain('expected idle');
    expect(harness.diagnosticTestTools.getBackgroundDispatchCount()).toBe(0);
  });
});
