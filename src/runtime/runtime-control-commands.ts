import type { RuntimeState } from '../schemas/index.js';
import { buildPauseRuntimeStatePatch, buildResumeRuntimeStatePatch } from './runtime-control-state.js';

export type RuntimeControlEventKind = 'paused' | 'resumed';

export interface RuntimeControlResult {
  ok: boolean;
  code: 'paused' | 'resumed' | 'unavailable' | 'error';
  statusCode?: number;
  status?: string;
  error?: string;
  message?: string;
  state?: RuntimeState;
}

export interface PauseResumeEffects {
  readState(): RuntimeState | null;
  now(): string;
  applyStatePatch(patch: Partial<RuntimeState>): void;
  setLifecyclePaused?(paused: boolean): void;
  setProcessBuffering?(enabled: boolean): void;
  beforeResumeStatePatch?(state: RuntimeState | null): void;
  requestImmediateTick?(): void | Promise<void>;
  emitRuntimeEvent?(kind: RuntimeControlEventKind): void;
  logEvent?(kind: RuntimeControlEventKind): void;
  sendNotification?(message: string): void;
}

export function pauseRuntimeCommand(_projectRoot: string, effects: PauseResumeEffects): RuntimeControlResult {
  try {
    const current = effects.readState();
    if (!current) return unavailableResult('pause');

    effects.setLifecyclePaused?.(true);
    effects.setProcessBuffering?.(true);
    effects.applyStatePatch(buildPauseRuntimeStatePatch());
    effects.emitRuntimeEvent?.('paused');
    effects.logEvent?.('paused');
    effects.sendNotification?.('Runtime was paused.');
    return pausedResult(effects.readState() ?? current);
  } catch (err) {
    return errorResult('pause', err);
  }
}

export function resumeRuntimeCommand(_projectRoot: string, effects: PauseResumeEffects): RuntimeControlResult {
  try {
    const current = effects.readState();
    if (!current) return unavailableResult('resume');

    effects.setLifecyclePaused?.(false);
    effects.setProcessBuffering?.(false);
    effects.beforeResumeStatePatch?.(current);
    effects.applyStatePatch(buildResumeRuntimeStatePatch(current));
    effects.emitRuntimeEvent?.('resumed');
    effects.logEvent?.('resumed');
    effects.sendNotification?.('Runtime was resumed.');
    void effects.requestImmediateTick?.();
    const state = effects.readState() ?? current;
    return {
      ok: true,
      code: 'resumed',
      status: state.status,
      state,
    };
  } catch (err) {
    return errorResult('resume', err);
  }
}

function unavailableResult(action: 'pause' | 'resume'): RuntimeControlResult {
  return {
    ok: false,
    code: 'unavailable',
    statusCode: 503,
    error: 'Runtime state is unavailable',
    message: action === 'pause'
      ? 'Cannot pause runtime: runtime state is not initialized. Start the runtime or initialize runtime state first.'
      : 'Cannot resume runtime: runtime state is not initialized. Start the runtime or restore runtime state first.',
  };
}

function pausedResult(state: RuntimeState): RuntimeControlResult {
  return {
    ok: true,
    code: 'paused',
    status: state.status,
    state,
  };
}

function errorResult(action: 'pause' | 'resume', err: unknown): RuntimeControlResult {
  return {
    ok: false,
    code: 'error',
    statusCode: 500,
    error: `Failed to ${action} runtime`,
    message: err instanceof Error ? err.message : String(err),
  };
}
