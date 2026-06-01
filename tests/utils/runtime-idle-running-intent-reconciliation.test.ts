import { describe, it, expect, afterEach } from '@jest/globals';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { initProjectTree } from '../../src/persistence/file-tree.js';
import { CardStore } from '../../src/cards/card-store.js';
import { Runtime } from '../../src/runtime/runtime.js';
import {
  appendRuntimeRun,
  initRuntimeState,
  readRuntimeState,
  saveRuntimeState,
} from '../../src/runtime/state.js';
import { releaseLock } from '../../src/runtime/lock.js';
import { FakeAgentAdapter } from '../../src/agents/fake-agent.js';

let root: string | null = null;
let runtime: Runtime | null = null;

afterEach(async () => {
  if (runtime) {
    try {
      await runtime.shutdown();
    } catch {
      // ignore cleanup failures in temp projects
    }
    runtime = null;
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
  it('stops expected-idle intent when the project and root run are already terminal with no active card', async () => {
    root = mkdtempSync(join(tmpdir(), 'saivage-idle-running-intent-'));
    initProjectTree(root);
    const cards = new CardStore(root);
    cards.update('project', {
      status: 'done',
      status_text: 'project terminal for stale-intent regression',
      result: { planning: { status: 'done', summary: 'terminal project' } },
    });

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
      result: null,
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
    runtime = new Runtime({ projectRoot: root, fakeAgentConfig: { mapping: { project: 'missing-fixture-should-not-dispatch' }, fixtureDir: root } }, fakeAgent);

    await runtime.startup();

    const reconciled = readRuntimeState(root);
    expect(reconciled?.status).toBe('idle');
    expect(reconciled?.current_card_id).toBeNull();
    expect(reconciled?.active_card_run).toBeNull();
    expect(reconciled?.runtime_intent?.status).toBe('stopped');
    expect(reconciled?.runtime_intent?.reason).toContain('expected idle');
    const reconciledRun = (reconciled?.runtime_runs ?? []).find((run) => run.run_id === rootRun.run_id);
    expect(reconciledRun?.phase).toBe('completed');
    expect(reconciledRun?.runtime_status).toBe('idle');
    expect(reconciledRun?.result).toBe('done');
    expect(reconciledRun?.finished_at).toBeTruthy();
    expect(runtime.getBackgroundDispatchCount()).toBe(0);
  });

  it('stops expected-idle intent when all root runs are already closed and project is terminal', async () => {
    root = mkdtempSync(join(tmpdir(), 'saivage-idle-running-intent-closed-'));
    initProjectTree(root);
    const cards = new CardStore(root);
    cards.update('project', {
      status: 'done',
      status_text: 'project terminal with closed root runs',
      result: { planning: { status: 'done', summary: 'terminal project' } },
    });

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
      result: 'done',
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
    runtime = new Runtime({ projectRoot: root, fakeAgentConfig: { mapping: { project: 'missing-fixture-should-not-dispatch' }, fixtureDir: root } }, fakeAgent);

    await runtime.startup();

    const reconciled = readRuntimeState(root);
    expect(reconciled?.status).toBe('idle');
    expect(reconciled?.current_card_id).toBeNull();
    expect(reconciled?.active_card_run).toBeNull();
    expect(reconciled?.runtime_intent?.status).toBe('stopped');
    expect(reconciled?.runtime_intent?.reason).toContain('expected idle');
    expect(runtime.getBackgroundDispatchCount()).toBe(0);
  });
});
