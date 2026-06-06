import { describe, expect, it, beforeEach, afterEach } from '@jest/globals';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { initProjectTree } from '../../src/persistence/file-tree.js';
import { clearFreezeManifest, readFreezeManifest, saveFreezeManifest } from '../../src/runtime/freeze-manifest.js';
import { buildFreezeManifest, buildFreezeRuntimeStatePatch, buildResumeFromFreezeRuntimeStatePatch, buildResumeHandoffContext } from '../../src/runtime/runtime-core.js';
import type { FreezeManifest, RuntimeState } from '../../src/schemas/types.js';

describe('freeze manifest helpers', () => {
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), 'saivage-freeze-manifest-'));
    initProjectTree(projectRoot);
  });

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
  });

  function manifest(overrides: Partial<FreezeManifest> = {}): FreezeManifest {
    return {
      freeze_id: 'freeze-test',
      reason: 'test freeze',
      created_at: new Date(0).toISOString(),
      status: 'frozen',
      project_id: 'project',
      pid: process.pid,
      started_at: new Date(0).toISOString(),
      active_card_run: null,
      queue: [],
      running_processes: [],
      handoff_summaries: [],
      schema_version: 1,
      runtime_version: '0.1.0',
      ...overrides,
    };
  }

  it('validates, saves, reads, and clears manifests', () => {
    const saved = saveFreezeManifest(projectRoot, manifest({ active_card_run: { card_id: 'card-a', card_type: 'goal', runtime_status: 'running', phase: 'planner', caller_session_id: null, caller_tool_call_id: null, planner_session_id: 'planner:card-a', correction_attempts: 0, started_at: new Date(0).toISOString(), last_turn_at: new Date(0).toISOString() } }));

    expect(saved.active_card_run?.card_id).toBe('card-a');
    expect(readFreezeManifest(projectRoot)).toEqual(saved);

    clearFreezeManifest(projectRoot);
    expect(readFreezeManifest(projectRoot)).toBeNull();
  });

  it('rejects invalid manifest shapes', () => {
    expect(() => saveFreezeManifest(projectRoot, { freeze_id: 'bad' } as unknown as FreezeManifest)).toThrow(
      'FreezeManifest validation failed',
    );
    expect(() => saveFreezeManifest(projectRoot, manifest({ status: 'idle' as unknown as 'frozen' }))).toThrow(
      'FreezeManifest validation failed',
    );
  });

  it('builds frozen state and resume state patches', () => {
    const state: RuntimeState = {
      status: 'running',
      project_id: 'project',
      pid: process.pid,
      started_at: 'started',
      active_card_run: { card_id: 'goal-a', card_type: 'goal', runtime_status: 'running', phase: 'planner', caller_session_id: null, caller_tool_call_id: null, planner_session_id: 'planner:goal-a', correction_attempts: 0, started_at: '2026-01-01T00:00:00.000Z', last_turn_at: '2026-01-01T00:00:00.000Z' },
      paused: false,
      updated_at: 'updated',
      runtime_intent: { status: 'running', updated_at: 'updated', source_command_id: null },
      runtime_commands: [],
      runtime_runs: [],
      runtime_activations: [],
    };
    const frozen = buildFreezeRuntimeStatePatch({ state, frozenAt: 'frozen-at' });

    expect(frozen).toEqual(expect.objectContaining({ status: 'frozen', paused: true, paused_at: 'frozen-at' }));
    expect(buildResumeFromFreezeRuntimeStatePatch(manifest({ active_card_run: state.active_card_run }))).toEqual(
      expect.objectContaining({ status: 'running', active_card_run: expect.objectContaining({ card_id: 'goal-a' }), paused: false, paused_at: null }),
    );
  });

  it('does not build handoff context without an active session', () => {
    const emptyContext = buildResumeHandoffContext(
      buildFreezeManifest({
        state: null,
        freezeId: 'freeze-handoff',
        frozenAt: new Date(0).toISOString(),
        pid: process.pid,
        runtimeVersion: '0.1.0',
        handoffSummaries: [],
      }),
    );

    expect(emptyContext).toBeNull();
  });

  it('builds active-session handoff context from manifest summaries', () => {
    const handoffContext = buildResumeHandoffContext(
      manifest({
        active_card_run: { card_id: 'card-1', card_type: 'code', runtime_status: 'running', phase: 'executor', caller_session_id: 'planner:project', caller_tool_call_id: 'call-1', executor_session_id: 'executor-card-1', correction_attempts: 0, started_at: new Date(0).toISOString(), last_turn_at: new Date(0).toISOString() },
        handoff_summaries: [
          {
            session_id: 'executor-card-1',
            role: 'executor',
            last_action: 'Writing implementation',
            next_action: 'Run tests',
            context_summary: 'Card: card-1',
          },
        ] as FreezeManifest['handoff_summaries'],
      }),
    );

    expect(handoffContext).toContain('[Handoff]');
    expect(handoffContext).toContain('executor-card-1');
    expect(handoffContext).toContain('Writing implementation');
    expect(handoffContext).toContain('Run tests');
  });
});
