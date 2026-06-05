import { describe, expect, it } from '@jest/globals';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initProjectTree } from '../../src/persistence/file-tree.js';
import { createRuntimeStateMutationPort } from '../../src/runtime/mutations.js';
import { initRuntimeState, readRuntimeState, updateRuntimeState } from '../../src/runtime/state.js';
import type { PlannerDoneResult } from '../../src/schemas/index.js';

const plannerDone: PlannerDoneResult = { kind: 'planner_done', summary: 'done' };

describe('runtime mutations', () => {
  it('applies runtime state patches through the mutation port', () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'runtime-mutations-patch-'));
    try {
      initProjectTree(projectRoot);
      initRuntimeState(projectRoot);

      createRuntimeStateMutationPort(projectRoot).apply({
        kind: 'patchRuntimeState',
        patch: {
          paused: true,
          current_card_id: 'goal-a',
          current_agent_session_id: 'planner:goal-a',
        },
      });

      expect(readRuntimeState(projectRoot)).toEqual(expect.objectContaining({
        paused: true,
        current_card_id: 'goal-a',
        current_agent_session_id: 'planner:goal-a',
      }));
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it('completes activation records through the mutation port', () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'runtime-mutations-'));
    try {
      initProjectTree(projectRoot);
      initRuntimeState(projectRoot);
      updateRuntimeState(projectRoot, {
        runtime_activations: [
          {
            activation_id: 'act-1',
            idempotency_key: 'idem-1',
            parent_card_id: 'parent',
            parent_run_id: 'run-parent',
            parent_session_id: 'planner:parent',
            parent_tool_call_id: 'call-1',
            child_card_id: 'child',
            status: 'running',
            precondition: 'accepted',
            requested_at: '2026-01-01T00:00:00.000Z',
            updated_at: '2026-01-01T00:00:00.000Z',
            runtime_run_id: null,
            error: null,
          },
        ],
      });

      createRuntimeStateMutationPort(projectRoot).apply({
        kind: 'completeActivation',
        childCardId: 'child',
        outcome: 'done',
        completedAt: '2026-01-01T00:01:00.000Z',
        lifecycle: { status: 'done', result: plannerDone, error: null, completed_at: '2026-01-01T00:01:00.000Z' },
      });

      expect(readRuntimeState(projectRoot)?.runtime_activations).toEqual([
        expect.objectContaining({
          activation_id: 'act-1',
          child_card_id: 'child',
          status: 'completed',
          updated_at: '2026-01-01T00:01:00.000Z',
          outcome: { kind: 'completed', outcome: 'done', card_id: 'child', completed_at: '2026-01-01T00:01:00.000Z' },
        }),
      ]);
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it('replaces runtime state through the mutation port', () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'runtime-mutations-replace-'));
    try {
      initProjectTree(projectRoot);
      const state = initRuntimeState(projectRoot);

      createRuntimeStateMutationPort(projectRoot).apply({
        kind: 'replaceRuntimeState',
        state: { ...state, paused: true, updated_at: '2026-01-01T00:00:00.000Z' },
      });

      expect(readRuntimeState(projectRoot)).toEqual(expect.objectContaining({
        paused: true,
        updated_at: '2026-01-01T00:00:00.000Z',
      }));
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it('mutates runtime runs and activations through the mutation port', () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'runtime-mutations-ledger-'));
    try {
      initProjectTree(projectRoot);
      initRuntimeState(projectRoot);

      const mutations = createRuntimeStateMutationPort(projectRoot);
      const run = mutations.apply({
        kind: 'appendRuntimeRun',
        run: {
          card_id: 'goal-a',
          kind: 'root',
          parent_run_id: null,
          command_id: null,
          activation_id: null,
          phase: 'planner',
          runtime_status: 'running',
          session_id: 'planner:goal-a',
        },
      });
      const updatedRun = mutations.apply({
        kind: 'updateRuntimeRun',
        runId: run.run_id,
        updates: { phase: 'completed', runtime_status: 'idle', outcome: { kind: 'completed', result: 'done', finished_at: '2026-01-01T00:01:00.000Z' } },
      });
      const activation = mutations.apply({
        kind: 'upsertRuntimeActivation',
        activation: {
          idempotency_key: 'idem-1',
          parent_card_id: 'parent',
          parent_run_id: 'run-parent',
          parent_session_id: 'planner:parent',
          parent_tool_call_id: 'call-1',
          child_card_id: 'goal-a',
          status: 'running',
          precondition: 'accepted',
          runtime_run_id: run.run_id,
          error: null,
        },
      });

      expect(updatedRun).toEqual(expect.objectContaining({
        run_id: run.run_id,
        phase: 'completed',
        runtime_status: 'idle',
        outcome: { kind: 'completed', result: 'done', finished_at: '2026-01-01T00:01:00.000Z' },
      }));
      expect(activation).toEqual(expect.objectContaining({
        idempotency_key: 'idem-1',
        child_card_id: 'goal-a',
      }));
      expect(readRuntimeState(projectRoot)).toEqual(expect.objectContaining({
        runtime_runs: [expect.objectContaining({ run_id: run.run_id, phase: 'completed' })],
        runtime_activations: [expect.objectContaining({ activation_id: activation.activation_id })],
      }));
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it('mutates runtime commands and intent through the mutation port', () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'runtime-mutations-commands-'));
    try {
      initProjectTree(projectRoot);
      initRuntimeState(projectRoot);

      const mutations = createRuntimeStateMutationPort(projectRoot);
      const command = mutations.apply({ kind: 'appendRuntimeCommand', commandKind: 'start_project', source: 'operator' });
      const state = mutations.apply({
        kind: 'upsertRuntimeIntent',
        status: 'running',
        sourceCommandId: command.command_id,
        reason: 'test start',
      });

      expect(command).toEqual(expect.objectContaining({ command: 'start_project', status: 'accepted' }));
      expect(state.runtime_intent).toEqual(expect.objectContaining({
        status: 'running',
        source_command_id: command.command_id,
        reason: 'test start',
      }));
      expect(readRuntimeState(projectRoot)).toEqual(expect.objectContaining({
        runtime_commands: [expect.objectContaining({ command_id: command.command_id })],
        runtime_intent: expect.objectContaining({ source_command_id: command.command_id }),
      }));
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it('completes commands from the locked current state without dropping intervening runs', () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'runtime-mutations-command-current-'));
    try {
      initProjectTree(projectRoot);
      initRuntimeState(projectRoot);

      const mutations = createRuntimeStateMutationPort(projectRoot);
      const command = mutations.apply({ kind: 'appendRuntimeCommand', commandKind: 'start_project', source: 'operator' });
      const run = mutations.apply({
        kind: 'appendRuntimeRun',
        run: {
          run_id: 'run-added-after-command-snapshot',
          card_id: 'project',
          kind: 'root',
          parent_run_id: null,
          command_id: command.command_id,
          activation_id: null,
          phase: 'planner',
          runtime_status: 'running',
          session_id: 'planner:project',
        },
      });

      const completed = mutations.apply({
        kind: 'completeRuntimeCommand',
        command,
        at: '2026-01-01T00:02:00.000Z',
      });

      expect(completed).toEqual(expect.objectContaining({
        command_id: command.command_id,
        status: 'completed',
        completed_at: '2026-01-01T00:02:00.000Z',
      }));
      expect(readRuntimeState(projectRoot)).toEqual(expect.objectContaining({
        runtime_commands: [expect.objectContaining({ command_id: command.command_id, status: 'completed' })],
        runtime_runs: [expect.objectContaining({ run_id: run.run_id })],
      }));
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it('merges startup repair snapshots without replacing newer ledger arrays', () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'runtime-mutations-merge-snapshot-'));
    try {
      initProjectTree(projectRoot);
      const staleSnapshot = initRuntimeState(projectRoot);
      const mutations = createRuntimeStateMutationPort(projectRoot);
      const command = mutations.apply({ kind: 'appendRuntimeCommand', commandKind: 'stop_project', source: 'runtime' });
      const run = mutations.apply({
        kind: 'appendRuntimeRun',
        run: {
          run_id: 'run-preserved-from-current-state',
          card_id: 'project',
          kind: 'root',
          parent_run_id: null,
          command_id: command.command_id,
          activation_id: null,
          phase: 'planner',
          runtime_status: 'running',
          session_id: 'planner:project',
        },
      });

      const merged = mutations.apply({
        kind: 'mergeRuntimeStateSnapshot',
        state: {
          ...staleSnapshot,
          paused: true,
          updated_at: '2026-01-01T00:03:00.000Z',
        },
      });

      expect(merged).toEqual(expect.objectContaining({ paused: true }));
      expect(readRuntimeState(projectRoot)).toEqual(expect.objectContaining({
        paused: true,
        runtime_commands: [expect.objectContaining({ command_id: command.command_id })],
        runtime_runs: [expect.objectContaining({ run_id: run.run_id })],
      }));
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});
