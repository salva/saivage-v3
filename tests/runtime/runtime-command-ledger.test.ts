import { describe, expect, it } from '@jest/globals';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Runtime } from '../../src/runtime/runtime.js';
import { readRuntimeState } from '../../src/runtime/state.js';

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
      runtime.dispatchGoal = (async () => {}) as Runtime['dispatchGoal'];
      await runtime.startProject('operator');
      const result = await runtime.stopProject('operator');
      expect(result.success).toBe(true);
      const state = readRuntimeState(projectRoot)!;
      expect(state.runtime_intent!.status).toBe('stopped');
      expect(state.runtime_commands).toEqual(expect.arrayContaining([expect.objectContaining({ command: 'stop_project', status: 'completed' })]));
      expect(state.runtime_runs!.filter((run) => run.kind === 'root').every((run) => run.finished_at || run.phase === 'completed')).toBe(true);
    } finally { rmSync(projectRoot, { recursive: true, force: true }); }
  });
});
