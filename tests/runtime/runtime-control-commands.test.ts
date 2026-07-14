import { initProjectTree } from '../helpers/canonical-project.js';
import { testActorSnapshots } from '../helpers/actor-snapshots.js';
import { describe, expect, it, jest } from '@jest/globals';

import {
  pauseRuntimeCommand,
  resumeRuntimeCommand,
  type PauseResumeEffects,
} from '../../src/runtime/runtime-control-commands.js';
import { pauseRuntimeControl, resumeRuntimeControl } from '../../src/runtime/control.js';

import { saveRuntimeState, testRuntimeStateStore } from '../helpers/runtime-state.js';
import type { RuntimeState } from '../../src/schemas/index.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

function runtimeState(overrides: Partial<RuntimeState> = {}): RuntimeState {
  return {
    status: 'stopped',
    project_id: 'project',
    pid: 1234,
    started_at: '2026-01-01T00:00:00.000Z',
    active_card_run: null,
    updated_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  } as RuntimeState;
}

function effects(state: RuntimeState | null, overrides: Partial<PauseResumeEffects> = {}): PauseResumeEffects {
  return {
    readState: () => state,
    now: () => '2026-01-01T00:00:01.000Z',
    applyStatePatch: jest.fn((patch: Partial<RuntimeState>) => {
      if (state) state = { ...state, ...patch };
    }),
    ...overrides,
  };
}

function controlContext(projectRoot: string) {
  const { store: runtimeState } = testRuntimeStateStore(projectRoot);
  return { projectRoot, runtimeState };
}

describe('runtime-control-commands', () => {
  it('rejects pause when runtime state is unavailable', () => {
    const applyStatePatch = jest.fn();
    const result = pauseRuntimeCommand('/project', effects(null, { applyStatePatch }));

    expect(result).toMatchObject({ ok: false, code: 'unavailable', statusCode: 503 });
    expect(applyStatePatch).not.toHaveBeenCalled();
  });

  it('computes the canonical pause patch and runs optional live effects', () => {
    const setLifecyclePaused = jest.fn();
    const setProcessBuffering = jest.fn();
    const result = pauseRuntimeCommand('/project', effects(runtimeState(), {
      setLifecyclePaused,
      setProcessBuffering,
    }));

    expect(result).toMatchObject({ ok: true, code: 'paused', status: 'paused' });
    expect(setLifecyclePaused).toHaveBeenCalledWith(true);
    expect(setProcessBuffering).toHaveBeenCalledWith(true);
  });

  it('lets the live effect port preserve best-effort state patch semantics', () => {
    const setLifecyclePaused = jest.fn();
    const result = resumeRuntimeCommand('/project', effects(runtimeState({ status: 'paused' }), {
      setLifecyclePaused,
      applyStatePatch: () => {
        try { throw new Error('state write failed'); } catch { void 0; }
      },
      requestImmediateTick: () => { void 0; },
    }));

    expect(result).toMatchObject({ ok: true, code: 'resumed' });
    expect(setLifecyclePaused).toHaveBeenCalledWith(false);
  });

  it('offline pause/resume controls persist state without live card notification delivery', () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'saivage-runtime-control-'));
    try {
      initProjectTree(projectRoot);
      saveRuntimeState(projectRoot, runtimeState({ status: 'running' }));
      testActorSnapshots(projectRoot).save({ actor_id: 'planner:project', actor_kind: 'llm', state_value: 'calling_provider', context: {}, updated_at: '2026-01-01T00:00:00.000Z' });

      const paused = pauseRuntimeControl(controlContext(projectRoot));
      const resumed = resumeRuntimeControl(controlContext(projectRoot));

      expect(paused).toMatchObject({ ok: true, code: 'paused', status: 'paused' });
      expect(resumed).toMatchObject({ ok: true, code: 'resumed', status: 'stopped' });
      expect(paused).not.toHaveProperty('notificationDelivery');
      expect(resumed).not.toHaveProperty('notificationDelivery');
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it('offline pause control ignores live card delivery hooks', () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'saivage-runtime-control-missing-'));
    try {
      initProjectTree(projectRoot);
      saveRuntimeState(projectRoot, runtimeState({ status: 'running' }));
      testActorSnapshots(projectRoot).save({ actor_id: 'planner:missing-project', actor_kind: 'llm', state_value: 'calling_provider', context: {}, updated_at: '2026-01-01T00:00:00.000Z' });

      const result = pauseRuntimeControl(controlContext(projectRoot));

      expect(result).toMatchObject({ ok: true, code: 'paused', status: 'paused' });
      expect(result).not.toHaveProperty('notificationDelivery');
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});
