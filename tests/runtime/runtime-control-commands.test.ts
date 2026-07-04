import { describe, expect, it, jest } from '@jest/globals';

import {
  pauseRuntimeCommand,
  resumeRuntimeCommand,
  type PauseResumeEffects,
} from '../../src/runtime/runtime-control-commands.js';
import { pauseRuntimeControl, resumeRuntimeControl, setRuntimeControlNotifyCard } from '../../src/runtime/control.js';
import { initProjectTree } from '../../src/persistence/file-tree.js';
import { saveRuntimeState } from '../../src/runtime/state.js';
import { saveActorSnapshot } from '../../src/runtime/actors/snapshots.js';
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

  it('routes persisted pause/resume notifications through notifyCard and reports delivery aggregates', () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'saivage-runtime-control-'));
    try {
      initProjectTree(projectRoot);
      saveRuntimeState(projectRoot, runtimeState({ status: 'running' }));
      saveActorSnapshot(projectRoot, { actor_id: 'planner:project', actor_kind: 'llm', state_value: 'calling_provider', context: {}, updated_at: '2026-01-01T00:00:00.000Z' });
      const notifyCard = jest.fn(() => ({ ok: true as const }));
      setRuntimeControlNotifyCard(projectRoot, notifyCard);

      const paused = pauseRuntimeControl({ projectRoot });
      const resumed = resumeRuntimeControl({ projectRoot });

      expect(paused).toMatchObject({ ok: true, notificationDelivery: { ok: true, cardDeliveries: [{ cardId: 'project', result: { ok: true } }], sessionDeliveries: ['planner:project'] } });
      expect(resumed).toMatchObject({ ok: true, notificationDelivery: { ok: true, cardDeliveries: [{ cardId: 'project', result: { ok: true } }], sessionDeliveries: ['planner:project'] } });
      expect(notifyCard).toHaveBeenCalledWith('project', expect.objectContaining({ message: 'Runtime was paused.', reason: 'runtime_state' }));
      expect(notifyCard).toHaveBeenCalledWith('project', expect.objectContaining({ message: 'Runtime was resumed.', reason: 'runtime_state' }));
    } finally {
      setRuntimeControlNotifyCard(projectRoot, undefined);
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it('reports missing-card pause delivery as a structured aggregate without throwing', () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'saivage-runtime-control-missing-'));
    try {
      initProjectTree(projectRoot);
      saveRuntimeState(projectRoot, runtimeState({ status: 'running' }));
      saveActorSnapshot(projectRoot, { actor_id: 'planner:missing-project', actor_kind: 'llm', state_value: 'calling_provider', context: {}, updated_at: '2026-01-01T00:00:00.000Z' });

      const result = pauseRuntimeControl({ projectRoot, notifyCard: () => ({ ok: false, reason: 'missing_card', cardId: 'missing-project' }) });

      expect(result).toMatchObject({ ok: true, notificationDelivery: { ok: false, cardDeliveries: [{ cardId: 'missing-project', result: { ok: false, reason: 'missing_card', cardId: 'missing-project' } }], sessionDeliveries: ['planner:missing-project'] } });
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});
