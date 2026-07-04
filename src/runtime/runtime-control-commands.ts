import type { RuntimeState } from '../schemas/index.js';
import { buildPauseRuntimeStatePatch, buildResumeRuntimeStatePatch } from './runtime-control-state.js';
import type { QueueNotificationResult } from '../notifications/index.js';

export interface RuntimeControlResult {
  ok: boolean;
  code: 'paused' | 'resumed' | 'unavailable' | 'error';
  statusCode?: number;
  status?: string;
  error?: string;
  message?: string;
  state?: RuntimeState;
  notificationDelivery?: QueueNotificationResult;
}

export interface PauseResumeEffects {
  readState(): RuntimeState | null;
  now(): string;
  applyStatePatch(patch: Partial<RuntimeState>): void;
  setLifecyclePaused?(paused: boolean): void;
  setProcessBuffering?(enabled: boolean): void;
  beforeResumeStatePatch?(state: RuntimeState | null): void;
  requestImmediateTick?(): void | Promise<void>;
  sendNotification?(message: string): QueueNotificationResult;
}

export function pauseRuntimeCommand(_projectRoot: string, effects: PauseResumeEffects): RuntimeControlResult {
  try {
    const current = effects.readState();
    if (!current) return unavailableResult('pause');

    effects.setLifecyclePaused?.(true);
    effects.setProcessBuffering?.(true);
    effects.applyStatePatch(buildPauseRuntimeStatePatch());
    const notificationDelivery = effects.sendNotification?.('Runtime was paused.');
    return pausedResult(effects.readState() ?? current, notificationDelivery);
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
    const notificationDelivery = effects.sendNotification?.('Runtime was resumed.');
    void effects.requestImmediateTick?.();
    const state = effects.readState() ?? current;
    return {
      ok: true,
      code: 'resumed',
      status: state.status,
      state,
      ...(notificationDelivery ? { notificationDelivery } : {}),
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

function pausedResult(state: RuntimeState, notificationDelivery?: QueueNotificationResult): RuntimeControlResult {
  return {
    ok: true,
    code: 'paused',
    status: state.status,
    state,
    ...(notificationDelivery ? { notificationDelivery } : {}),
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
