import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { initProjectTree } from '../../src/persistence/file-tree.js';
import { writeFileAtomic } from '../../src/persistence/durable-write.js';
import {
  initRuntimeState,
  readRuntimeState,
  saveRuntimeState,
  updateRuntimeState,
  RuntimeStateInvariantError,
} from '../../src/runtime/state.js';
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
    ownership: { kind: 'direct', source: 'project_root' },
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

function corruptStoppedState(): RuntimeState {
  const base = initRuntimeState(root);
  const corrupted: RuntimeState = {
    ...base,
    status: 'stopped',
    active_card_run: runningRun(),
    updated_at: new Date().toISOString(),
  };
  writeFileAtomic(statePath(), JSON.stringify({ version: 1, data: corrupted }, null, 2) + '\n');
  return corrupted;
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

describe('RuntimeState stopped active_card_run invariant', () => {
  it('rejects saving stopped with a running active_card_run in strict test mode', () => {
    const base = initRuntimeState(root);
    expect(() => saveRuntimeState(root, {
      ...base,
      status: 'stopped',
      active_card_run: runningRun(),
    })).toThrow(RuntimeStateInvariantError);
  });

  it('rejects cancelled as top-level RuntimeState.status and stopped/cancelled active_card_run.runtime_status', () => {
    const base = initRuntimeState(root);

    for (const terminalStatus of ['cancelled'] as const) {
      expect(runtimeStateSchema.safeParse({
        ...base,
        status: terminalStatus,
      }).success).toBe(false);

      const parsed = runtimeStateSchema.safeParse({
        ...base,
        status: 'running',
        active_card_run: runningRun({ runtime_status: terminalStatus } as unknown as Partial<ActiveCardRun>),
      } as unknown as RuntimeState);
      expect(parsed.success).toBe(false);
    }
  });

  it('allows stopped transitions only when active_card_run is cleared', () => {
    initRuntimeState(root);
    updateRuntimeState(root, {
      status: 'running',
      active_card_run: runningRun(),
    });

    const cleared = updateRuntimeState(root, {
      status: 'stopped',
      active_card_run: null,
    });
    expect(cleared.active_card_run).toBeNull();

    expect(() => updateRuntimeState(root, {
      status: 'stopped',
      active_card_run: runningRun(),
    })).toThrow(RuntimeStateInvariantError);

    expect(() => saveRuntimeState(root, {
      ...cleared,
      status: 'running',
      active_card_run: runningRun({ runtime_status: 'cancelled' } as unknown as Partial<ActiveCardRun>),
    })).toThrow(/validation failed/);
  });

  it('fails closed on corrupted persisted state in every environment instead of production self-heal', () => {
    corruptStoppedState();
    process.env['NODE_ENV'] = 'production';

    expect(() => readRuntimeState(root)).toThrow(RuntimeStateInvariantError);
    const persisted = JSON.parse(readFileSync(statePath(), 'utf-8')) as { version?: number; data?: RuntimeState } | RuntimeState;
    const persistedState = 'data' in persisted ? persisted.data as RuntimeState : persisted as RuntimeState;
    expect(persistedState.active_card_run?.runtime_status).toBe('running');
  });

  it('fails closed on malformed JSON and legacy-shaped current-schema omissions', () => {
    initRuntimeState(root);
    writeFileSync(statePath(), '{bad', 'utf-8');
    expect(() => readRuntimeState(root)).toThrow(/malformed JSON/);

    writeFileAtomic(statePath(), JSON.stringify({ version: 1, data: { status: 'stopped', project_id: 'project' } }, null, 2) + '\n');
    expect(() => readRuntimeState(root)).toThrow(/validation failed/);
  });

  it('post-startup-repair stopped settle writes through saveRuntimeState and cannot preserve a stale active run', () => {
    const previousState = initRuntimeState(root);
    const buildStartupRepairSettleState = (parentRun: ActiveCardRun | null): RuntimeState => ({
      ...previousState,
      status: parentRun ? 'running' : 'stopped',
      active_card_run: parentRun,
      updated_at: new Date().toISOString(),
    });

    const repairedWrite = (): RuntimeState => saveRuntimeState(root, buildStartupRepairSettleState(null));

    expect(repairedWrite()).toMatchObject({
      status: 'stopped',
      active_card_run: null,
    });
  });
});
