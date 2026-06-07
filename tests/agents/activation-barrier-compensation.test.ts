import { describe, expect, it } from '@jest/globals';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compensateActivationBarrierThrow } from '../../src/agents/activation-barrier-compensation.js';
import { SessionMessageLog } from '../../src/agents/session-message-log.js';
import { initProjectTree } from '../../src/persistence/file-tree.js';
import { appendRuntimeRun, initRuntimeState, readRuntimeState, updateRuntimeState, upsertRuntimeActivation } from '../../src/runtime/state.js';

describe('activation barrier compensation', () => {
  it('completes failed activation without clearing restored parent planner active run', () => {
    const root = mkdtempSync(join(tmpdir(), 'saivage-activation-barrier-compensation-'));
    try {
      initProjectTree(root);
      initRuntimeState(root);
      const parentRun = appendRuntimeRun(root, { run_id: 'run-parent', kind: 'root', card_id: 'project', parent_run_id: null, command_id: null, activation_id: null, phase: 'planner', runtime_status: 'running', session_id: 'planner:project' });
      const childRun = appendRuntimeRun(root, { run_id: 'run-child', kind: 'child', card_id: 'card-1', parent_run_id: parentRun.run_id, command_id: null, activation_id: null, phase: 'executor', runtime_status: 'running', session_id: 'executor-card-1' });
      const activation = upsertRuntimeActivation(root, {
        idempotency_key: 'run-parent:call-a:card-1',
        parent_card_id: 'project',
        parent_run_id: parentRun.run_id,
        parent_session_id: 'planner:project',
        parent_tool_call_id: 'call-a',
        child_card_id: 'card-1',
        status: 'running',
        precondition: 'accepted',
        runtime_run_id: childRun.run_id,
        error: null,
      });
      updateRuntimeState(root, {
        status: 'running',
        active_card_run: {
          card_id: 'card-1',
          card_type: 'code',
          phase: 'executor',
          runtime_status: 'running',
          caller_session_id: 'planner:project',
          caller_tool_call_id: 'call-a',
          executor_session_id: 'executor-card-1',
          correction_attempts: 0,
          started_at: '2026-01-01T00:00:00.000Z',
          last_turn_at: '2026-01-01T00:00:00.000Z',
        },
      });

      compensateActivationBarrierThrow({ projectRoot: root, saivageDir: join(root, '.saivage'), messageLog: new SessionMessageLog(join(root, '.saivage')), redactProviderErrorMessage: String }, 'planner:project', 'call-a', activation, new Error('dispatch failed'));

      const state = readRuntimeState(root);
      expect(state?.runtime_activations?.find((candidate) => candidate.activation_id === activation.activation_id)).toEqual(expect.objectContaining({ status: 'failed' }));
      expect(state?.runtime_runs?.find((candidate) => candidate.run_id === childRun.run_id)).toEqual(expect.objectContaining({ phase: 'failed', runtime_status: 'error' }));
      expect(state?.active_card_run).toEqual(expect.objectContaining({ card_id: 'project', phase: 'planner', planner_session_id: 'planner:project' }));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
