import { describe, expect, it } from '@jest/globals';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Runtime } from '../../src/runtime/runtime.js';
import { initProjectTree } from '../../src/utils/file-tree.js';
import { appendRuntimeRun, readRuntimeState, upsertRuntimeActivation } from '../../src/runtime/state.js';

function root(): string { return mkdtempSync(join(tmpdir(), 'saivage-runtime-command-')); }

describe('runtime command ledger target contract (Wave 1)', () => {
  it('start_project records running intent and creates a root run before dispatch side effects', async () => {
    const projectRoot = root();
    try {
      const runtime = new Runtime({ projectRoot, fakeAgentConfig: { mapping: {}, fixtureDir: '' }, autoDispatchBacklog: false });
      const calls: string[] = [];
      runtime.dispatchGoal = (async (goalId: string) => { calls.push(goalId); }) as Runtime['dispatchGoal'];
      const result = await runtime.startProject('operator');
      expect(result.success).toBe(true);
      const state = readRuntimeState(projectRoot)!;
      expect(state.runtime_intent!.status).toBe('running');
      expect(state.runtime_commands).toEqual(expect.arrayContaining([expect.objectContaining({ command: 'start_project', status: 'completed' })]));
      expect(state.runtime_runs).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'root', card_id: 'project', command_id: result.command.command_id })]));
      expect(calls).toEqual(['project']);
    } finally { rmSync(projectRoot, { recursive: true, force: true }); }
  });

  it('stop_project records stopped intent and terminally marks open root runs', async () => {
    const projectRoot = root();
    try {
      const runtime = new Runtime({ projectRoot, fakeAgentConfig: { mapping: {}, fixtureDir: '' }, autoDispatchBacklog: false });
      runtime.dispatchGoal = (async () => { await new Promise<void>((resolve) => setImmediate(resolve)); }) as Runtime['dispatchGoal'];
      const startResult = await runtime.startProject('operator');
      if (!startResult.success) throw new Error(`startProject failed: ${startResult.error.message}`);
      const result = await runtime.stopProject('operator');
      expect(result.success).toBe(true);
      expect(result.run).toMatchObject({
        run_id: startResult.run.run_id,
        kind: 'root',
        card_id: 'project',
        command_id: startResult.command.command_id,
        phase: 'stopped',
        runtime_status: 'stopped',
        result: 'stopped',
      });
      expect(result.run!.finished_at).toEqual(expect.any(String));
      const state = readRuntimeState(projectRoot)!;
      expect(state.runtime_intent!.status).toBe('stopped');
      expect(state.runtime_commands).toEqual(expect.arrayContaining([expect.objectContaining({ command: 'stop_project', status: 'completed' })]));
      expect(state.runtime_runs).toEqual(expect.arrayContaining([expect.objectContaining({ run_id: startResult.run.run_id, finished_at: result.run!.finished_at })]));
      expect(state.runtime_runs!.filter((run) => run.kind === 'root').every((run) => run.finished_at || run.phase === 'completed')).toBe(true);
    } finally { rmSync(projectRoot, { recursive: true, force: true }); }
  });

  it('stop_project omits run when no root run was open', async () => {
    const projectRoot = root();
    try {
      const runtime = new Runtime({ projectRoot, fakeAgentConfig: { mapping: {}, fixtureDir: '' }, autoDispatchBacklog: false });
      const result = await runtime.stopProject('operator');
      expect(result.success).toBe(true);
      expect(result.intent!.status).toBe('stopped');
      expect(result.run).toBeUndefined();
    } finally { rmSync(projectRoot, { recursive: true, force: true }); }
  });

  it('shutdown preserves runtime intent, command, run, and activation ledgers after project start and child activation setup', async () => {
    const projectRoot = root();
    try {
      initProjectTree(projectRoot);
      const runtime = new Runtime({ projectRoot, fakeAgentConfig: { mapping: {}, fixtureDir: '' }, autoDispatchBacklog: false });
      runtime.dispatchGoal = (async () => {}) as Runtime['dispatchGoal'];
      await runtime.startup();
      const result = await runtime.startProject('operator');
      if (!result.success) throw new Error(`startProject failed: ${result.error.message}`);
      expect(result.success).toBe(true);
      const parentRun = result.run;
      const childRun = appendRuntimeRun(projectRoot, {
        kind: 'child',
        card_id: 'child-a',
        parent_run_id: parentRun.run_id,
        command_id: null,
        activation_id: 'activation-a',
        phase: 'executor',
        runtime_status: 'running',
        session_id: 'executor-child-a',
        result: null,
      });
      const activation = upsertRuntimeActivation(projectRoot, {
        activation_id: 'activation-a',
        idempotency_key: 'parent-run:child-a',
        parent_card_id: 'project',
        parent_run_id: parentRun.run_id,
        parent_session_id: 'planner:project',
        parent_tool_call_id: 'tool-call-a',
        child_card_id: 'child-a',
        status: 'running',
        precondition: 'accepted',
        runtime_run_id: childRun.run_id,
      });
      const beforeShutdown = readRuntimeState(projectRoot)!;
      expect(beforeShutdown.runtime_intent!.status).toBe('running');
      expect(beforeShutdown.runtime_commands).toHaveLength(1);
      expect(beforeShutdown.runtime_runs).toEqual(expect.arrayContaining([expect.objectContaining({ run_id: parentRun.run_id }), expect.objectContaining({ run_id: childRun.run_id })]));
      expect(beforeShutdown.runtime_activations).toEqual(expect.arrayContaining([expect.objectContaining({ activation_id: activation.activation_id, runtime_run_id: childRun.run_id })]));

      await runtime.shutdown();

      const afterShutdown = readRuntimeState(projectRoot)!;
      expect(afterShutdown.status).toBe('idle');
      expect(afterShutdown.runtime_intent).toEqual(beforeShutdown.runtime_intent);
      expect(afterShutdown.runtime_commands).toEqual(beforeShutdown.runtime_commands);
      expect(afterShutdown.runtime_runs).toEqual(beforeShutdown.runtime_runs);
      expect(afterShutdown.runtime_activations).toEqual(beforeShutdown.runtime_activations);
    } finally { rmSync(projectRoot, { recursive: true, force: true }); }
  });

});
