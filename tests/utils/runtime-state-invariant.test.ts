import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { initProjectTree, writeFileAtomic } from '../../src/utils/file-tree.js';
import {
  initRuntimeState,
  readRuntimeState,
  saveRuntimeState,
  updateRuntimeState,
  RuntimeStateInvariantError,
} from '../../src/runtime/state.js';
import { createServer, type ServerInstance } from '../../src/server/server.js';
import { runtimeStateSchema } from '../../src/schemas/validators.js';
import type { ActiveCardRun, RuntimeState } from '../../src/schemas/types.js';

let root: string;
let originalNodeEnv: string | undefined;

function statePath(): string {
  return join(root, '.saivage', 'tmp', 'state', 'runtime.json');
}

function runningRun(overrides: Partial<ActiveCardRun> = {}): ActiveCardRun {
  const now = new Date().toISOString();
  return {
    card_id: 'goal-a',
    card_type: 'goal',
    runtime_status: 'running',
    phase: 'planner',
    caller_session_id: null,
    caller_tool_call_id: null,
    planner_session_id: 'planner:goal-a',
    correction_attempts: 0,
    started_at: now,
    last_turn_at: now,
    ...overrides,
  };
}

function corruptIdleState(): RuntimeState {
  const base = initRuntimeState(root);
  const corrupted: RuntimeState = {
    ...base,
    status: 'idle',
    current_card_id: null,
    current_agent_session_id: 'planner:goal-a',
    active_card_run: runningRun(),
    running_processes: ['proc-1'],
    updated_at: new Date().toISOString(),
  };
  writeFileAtomic(statePath(), JSON.stringify(corrupted, null, 2) + '\n');
  return corrupted;
}

function readEvents(): Array<Record<string, unknown>> {
  const raw = readFileSync(join(root, '.saivage', 'runtime', 'events.jsonl'), 'utf-8');
  return raw.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
}

beforeEach(() => {
  originalNodeEnv = process.env['NODE_ENV'];
  process.env['NODE_ENV'] = 'test';
  root = mkdtempSync(join(tmpdir(), 'saivage-runtime-state-invariant-'));
  initProjectTree(root);
});

afterEach(() => {
  if (originalNodeEnv === undefined) {
    delete process.env['NODE_ENV'];
  } else {
    process.env['NODE_ENV'] = originalNodeEnv;
  }
  rmSync(root, { recursive: true, force: true });
});

describe('RuntimeState idle active_card_run invariant', () => {
  it('rejects saving idle/current_card_id null with a running active_card_run in strict test mode', () => {
    const base = initRuntimeState(root);
    expect(() => saveRuntimeState(root, {
      ...base,
      status: 'idle',
      current_card_id: null,
      active_card_run: runningRun(),
    })).toThrow(RuntimeStateInvariantError);
  });

  it('rejects stopped/cancelled as top-level RuntimeState.status while permitting them on active_card_run.runtime_status', () => {
    const base = initRuntimeState(root);

    for (const terminalStatus of ['stopped', 'cancelled'] as const) {
      expect(runtimeStateSchema.safeParse({
        ...base,
        status: terminalStatus,
      }).success).toBe(false);

      const parsed = runtimeStateSchema.safeParse({
        ...base,
        status: 'idle',
        current_card_id: null,
        active_card_run: runningRun({ runtime_status: terminalStatus }),
      });
      expect(parsed.success).toBe(true);
      expect(parsed.success && parsed.data.active_card_run?.runtime_status).toBe(terminalStatus);
    }
  });

  it('allows idle transitions that clear active_card_run or retain only documented terminal stopped/cancelled records', () => {
    initRuntimeState(root);
    updateRuntimeState(root, {
      status: 'running',
      current_card_id: 'goal-a',
      current_agent_session_id: 'planner:goal-a',
      active_card_run: runningRun(),
    });

    const cleared = updateRuntimeState(root, {
      status: 'idle',
      current_card_id: null,
      current_agent_session_id: null,
      active_card_run: null,
      running_processes: [],
    });
    expect(cleared.active_card_run).toBeNull();

    const stopped = updateRuntimeState(root, {
      status: 'idle',
      current_card_id: null,
      current_agent_session_id: null,
      active_card_run: runningRun({ runtime_status: 'stopped' }),
    });
    expect(stopped.active_card_run?.runtime_status).toBe('stopped');

    const cancelled = updateRuntimeState(root, {
      status: 'idle',
      current_card_id: null,
      current_agent_session_id: null,
      active_card_run: runningRun({ runtime_status: 'cancelled' }),
    });
    expect(cancelled.active_card_run?.runtime_status).toBe('cancelled');
  });

  it('self-heals corrupted historical persisted state in production reads and emits a warning event', () => {
    corruptIdleState();
    process.env['NODE_ENV'] = 'production';

    const state = readRuntimeState(root);
    expect(state).toMatchObject({
      status: 'idle',
      current_card_id: null,
      current_agent_session_id: null,
      active_card_run: null,
      running_processes: [],
    });

    const persisted = JSON.parse(readFileSync(statePath(), 'utf-8')) as RuntimeState;
    expect(persisted.active_card_run).toBeNull();
    const warning = readEvents().find((event) => event.phase === 'runtime_state_invariant');
    expect(warning).toMatchObject({
      kind: 'error',
      severity: 'warning',
      self_healed: true,
      card_id: 'goal-a',
    });
    expect(String(warning?.error_message)).toContain('Auto-cleared active_card_run during read');
  });

  it('/api/state returns coherent runtime data after restart-style load of a corrupted historical state', async () => {
    corruptIdleState();
    process.env['NODE_ENV'] = 'production';
    let server: ServerInstance | null = null;
    try {
      server = await createServer(root, false);
      const response = await server.fastify.inject({ method: 'GET', url: '/api/state' });
      expect(response.statusCode).toBe(200);
      expect(response.json().runtime).toMatchObject({
        status: 'idle',
        current_card_id: null,
        current_agent_session_id: null,
        active_card_run: null,
      });
      expect(readEvents().some((event) => event.phase === 'runtime_state_invariant' && event.self_healed === true)).toBe(true);
    } finally {
      await server?.stop();
    }
  });

  it('post-startup-repair idle settle writes through saveRuntimeState and cannot preserve a stale active run', () => {
    const previousState = initRuntimeState(root);
    const buildStartupRepairSettleState = (parentRun: ActiveCardRun | null): RuntimeState => ({
      ...previousState,
      status: parentRun ? 'running' : 'idle',
      current_card_id: parentRun?.card_id ?? null,
      current_agent_session_id: parentRun?.planner_session_id ?? null,
      active_card_run: parentRun,
      running_processes: [],
      updated_at: new Date().toISOString(),
      paused: false,
      paused_at: null,
    });

    const repairedWrite = (): RuntimeState => saveRuntimeState(root, buildStartupRepairSettleState(null));

    expect(repairedWrite()).toMatchObject({
      status: 'idle',
      current_card_id: null,
      current_agent_session_id: null,
      active_card_run: null,
      running_processes: [],
    });
  });
});
