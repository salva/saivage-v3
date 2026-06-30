import { describe, expect, it, jest } from '@jest/globals';

import {
  pauseRuntimeCommand,
  resumeRuntimeCommand,
  type PauseResumeEffects,
} from '../../src/runtime/runtime-control-commands.js';
import type { RuntimeState } from '../../src/schemas/index.js';

function runtimeState(overrides: Partial<RuntimeState> = {}): RuntimeState {
  return {
    status: 'stopped',
    project_id: 'project',
    pid: 1234,
    started_at: '2026-01-01T00:00:00.000Z',
    active_card_run: null,
    updated_at: '2026-01-01T00:00:00.000Z',
    runtime_commands: [],
    runtime_runs: [],
    runtime_activations: [],
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
    const emitRuntimeEvent = jest.fn();
    const logEvent = jest.fn();
    const result = pauseRuntimeCommand('/project', effects(runtimeState(), {
      setLifecyclePaused,
      setProcessBuffering,
      emitRuntimeEvent,
      logEvent,
    }));

    expect(result).toMatchObject({ ok: true, code: 'paused', status: 'paused' });
    expect(setLifecyclePaused).toHaveBeenCalledWith(true);
    expect(setProcessBuffering).toHaveBeenCalledWith(true);
    expect(emitRuntimeEvent).toHaveBeenCalledWith('paused');
    expect(logEvent).toHaveBeenCalledWith('paused');
  });

  it('lets the live effect port preserve best-effort state patch semantics', () => {
    const setLifecyclePaused = jest.fn();
    const emitRuntimeEvent = jest.fn();
    const logEvent = jest.fn();
    const result = resumeRuntimeCommand('/project', effects(runtimeState({ status: 'paused' }), {
      setLifecyclePaused,
      applyStatePatch: () => {
        try { throw new Error('state write failed'); } catch { void 0; }
      },
      emitRuntimeEvent,
      logEvent,
      requestImmediateTick: () => { void 0; },
    }));

    expect(result).toMatchObject({ ok: true, code: 'resumed' });
    expect(setLifecyclePaused).toHaveBeenCalledWith(false);
    expect(emitRuntimeEvent).toHaveBeenCalledWith('resumed');
    expect(logEvent).toHaveBeenCalledWith('resumed');
  });
});
