import { readRuntimeState, updateRuntimeState } from './state.js';
import type { ActiveRuntime } from './active-runtime.js';
import { enqueueRuntimeStateNotifications } from '../notifications/index.js';
import type { RuntimeState } from '../schemas/index.js';

/**
 * Shared runtime-control authority for pause/resume semantics.
 *
 * Accepted semantics:
 * - live + active runtime available: mutate persisted state through runtime-owned
 *   pause/resume behavior and mirror the resulting in-memory state.
 * - live + no active runtime authority: mutate only persisted runtime state so
 *   operator controls still work against server-only or analyst-only contexts.
 * - frozen: generic resume is rejected everywhere with actionable
 *   resume-from-freeze guidance; pause is idempotent and preserves frozen state.
 * - stopped/unavailable: if no runtime state exists, controls fail with an
 *   actionable initialization error rather than creating an unsafe shim state.
 */

export const RESUME_FROM_FREEZE_MESSAGE = 'Runtime is frozen. Use POST /api/runtime/resume-from-freeze to restore from the freeze manifest before resuming dispatch.';

export interface RuntimeControlContext {
  projectRoot: string;
  activeRuntime?: ActiveRuntime;
}

export interface RuntimeControlResult {
  ok: boolean;
  code: 'paused' | 'resumed' | 'frozen' | 'unavailable' | 'error';
  statusCode?: number;
  status?: string;
  paused?: boolean;
  error?: string;
  message?: string;
  action?: 'resume-from-freeze';
  state?: RuntimeState;
}

export function pauseRuntimeControl(ctx: RuntimeControlContext): RuntimeControlResult {
  try {
    const current = readRuntimeState(ctx.projectRoot);
    if (!current) {
      return {
        ok: false,
        code: 'unavailable',
        statusCode: 503,
        error: 'Runtime state is unavailable',
        message: 'Cannot pause runtime: runtime state is not initialized. Start the runtime or initialize runtime state first.',
      };
    }
    if (current.status === 'frozen') {
      return {
        ok: true,
        code: 'paused',
        status: current.status,
        paused: current.paused,
        state: current,
      };
    }
    let state: RuntimeState;
    if (ctx.activeRuntime) {
      ctx.activeRuntime.pause();
      state = readRuntimeState(ctx.projectRoot) ?? current;
    } else {
      state = updateRuntimeState(ctx.projectRoot, {
        status: 'paused',
        paused: true,
        paused_at: new Date().toISOString(),
      });
    }
    enqueueRuntimeStateNotifications(ctx.projectRoot, 'paused', { actor: 'runtime', surface: 'runtime' });
    return {
      ok: true,
      code: 'paused',
      status: state.status,
      paused: state.paused,
      state,
    };
  } catch (err) {
    return {
      ok: false,
      code: 'error',
      statusCode: 500,
      error: 'Failed to pause runtime',
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

export function resumeRuntimeControl(ctx: RuntimeControlContext): RuntimeControlResult {
  try {
    const current = readRuntimeState(ctx.projectRoot);
    if (!current) {
      return {
        ok: false,
        code: 'unavailable',
        statusCode: 503,
        error: 'Runtime state is unavailable',
        message: 'Cannot resume runtime: runtime state is not initialized. Start the runtime or restore runtime state first.',
      };
    }
    if (current.status === 'frozen') {
      return {
        ok: false,
        code: 'frozen',
        statusCode: 400,
        error: 'Runtime is frozen',
        message: RESUME_FROM_FREEZE_MESSAGE,
        action: 'resume-from-freeze',
      };
    }
    let state: RuntimeState;
    if (ctx.activeRuntime) {
      ctx.activeRuntime.resume();
      state = readRuntimeState(ctx.projectRoot) ?? current;
    } else {
      state = updateRuntimeState(ctx.projectRoot, {
        status: 'idle',
        paused: false,
        paused_at: null,
      });
    }
    enqueueRuntimeStateNotifications(ctx.projectRoot, 'resumed', { actor: 'runtime', surface: 'runtime' });
    return {
      ok: true,
      code: 'resumed',
      status: state.status,
      paused: state.paused,
      state,
    };
  } catch (err) {
    return {
      ok: false,
      code: 'error',
      statusCode: 500,
      error: 'Failed to resume runtime',
      message: err instanceof Error ? err.message : String(err),
    };
  }
}
