import { describe, expect, it } from '@jest/globals';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initProjectTree } from '../../src/persistence/file-tree.js';
import { createRuntimeStateMutationPort } from '../../src/runtime/mutations.js';
import { initRuntimeState, readRuntimeState, updateRuntimeState } from '../../src/runtime/state.js';

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
      });

      expect(readRuntimeState(projectRoot)?.runtime_activations).toEqual([
        expect.objectContaining({
          activation_id: 'act-1',
          child_card_id: 'child',
          status: 'completed',
          updated_at: '2026-01-01T00:01:00.000Z',
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
});
