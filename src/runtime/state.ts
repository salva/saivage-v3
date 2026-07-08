import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { runtimeStateSchema } from '../schemas/index.js';
import type { ZodType } from 'zod';
import { explainLegacyStateRejection } from '../persistence/index.js';
import { AtomicJsonFile, ProjectLock, PersistenceReadError, PersistenceValidationError } from '../persistence/index.js';
import type { RuntimeActivationRecord, RuntimeActivationStatus, RuntimeCommandName, RuntimeCommandRecord, RuntimeRunRecord, RuntimeState } from '../schemas/index.js';
import { createDefaultRuntimeState } from './default-state.js';

const AUTHORITATIVE_STATE_FILE = 'runtime.json';
const runtimeStatePersistenceSchema = runtimeStateSchema as ZodType<RuntimeState>;

export const UNRESOLVED_RUNTIME_ACTIVATION_STATUSES = new Set<RuntimeActivationStatus>([
  'pending',
  'running',
]);

export function isUnresolvedRuntimeActivationStatus(status: RuntimeActivationStatus): boolean {
  return UNRESOLVED_RUNTIME_ACTIVATION_STATUSES.has(status);
}

export class RuntimeStateInvariantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RuntimeStateInvariantError';
  }
}

export class RuntimeActivationInvariantError extends RuntimeStateInvariantError {
  constructor(message: string) {
    super(message);
    this.name = 'RuntimeActivationInvariantError';
  }
}

export class RuntimeDispatchInvariantError extends RuntimeStateInvariantError {
  constructor(message: string) {
    super(message);
    this.name = 'RuntimeDispatchInvariantError';
  }
}

export function runtimeStatePath(projectRoot: string): string {
  return join(projectRoot, '.saivage', 'tmp', 'state', AUTHORITATIVE_STATE_FILE);
}

function runtimeStateLock(projectRoot: string): ProjectLock {
  return new ProjectLock(join(projectRoot, '.saivage', '.lock'));
}

function runtimeStateFile(projectRoot: string): AtomicJsonFile<RuntimeState> {
  return new AtomicJsonFile(runtimeStatePath(projectRoot), runtimeStatePersistenceSchema, runtimeStateLock(projectRoot), { version: 1 });
}

function describeInvariantViolation(state: RuntimeState): string {
  const status = state.active_card_run?.runtime_status ?? 'null';
  const cardId = state.active_card_run?.card_id ?? 'null';
  return `RuntimeState invariant violation: ${state.status} runtime cannot retain active_card_run (card_id=${cardId}, runtime_status=${status}). Reset .saivage runtime state and restart.`;
}

function assertRuntimeStateInvariants(state: RuntimeState): RuntimeState {
  if ((state.status !== 'stopped' && state.status !== 'paused') || state.active_card_run === null) {
    return state;
  }
  throw new RuntimeStateInvariantError(describeInvariantViolation(state));
}

function defaultRuntimeState(): RuntimeState {
  return createDefaultRuntimeState();
}

function readRuntimeStateFile(projectRoot: string): RuntimeState {
  try {
    return assertRuntimeStateInvariants(runtimeStateFile(projectRoot).read());
  } catch (error) {
    if (error instanceof PersistenceValidationError || error instanceof PersistenceReadError) {
      throw error;
    }
    throw error;
  }
}

export function initRuntimeState(projectRoot: string): RuntimeState {
  const state = defaultRuntimeState();
  const lock = runtimeStateLock(projectRoot);
  const file = new AtomicJsonFile(runtimeStatePath(projectRoot), runtimeStatePersistenceSchema, lock, { version: 1 });
  lock.withLockSync((handle) => file.writeSync(handle, state));
  return state;
}

export function saveRuntimeState(projectRoot: string, state: RuntimeState): RuntimeState {
  const parsed = runtimeStatePersistenceSchema.safeParse(state);
  if (!parsed.success) {
    explainLegacyStateRejection(projectRoot, 'RuntimeState', parsed.error.message);
  }
  const validated = assertRuntimeStateInvariants(parsed.data);
  const lock = runtimeStateLock(projectRoot);
  const file = new AtomicJsonFile(runtimeStatePath(projectRoot), runtimeStatePersistenceSchema, lock, { version: 1 });
  lock.withLockSync((handle) => file.writeSync(handle, validated));
  return validated;
}

export function readRuntimeState(projectRoot: string): RuntimeState | null {
  if (!existsSync(runtimeStatePath(projectRoot))) {
    return null;
  }
  return readRuntimeStateFile(projectRoot);
}

export function updateRuntimeState(
  projectRoot: string,
  changes: Partial<RuntimeState>,
): RuntimeState {
  const lock = runtimeStateLock(projectRoot);
  const file = new AtomicJsonFile(runtimeStatePath(projectRoot), runtimeStatePersistenceSchema, lock, { version: 1 });
  return lock.withLockSync((handle) => {
    if (!existsSync(runtimeStatePath(projectRoot))) {
      file.writeSync(handle, defaultRuntimeState());
    }
    return file.updateSync(handle, (current) => assertRuntimeStateInvariants({
      ...current,
      ...changes,
      updated_at: new Date().toISOString(),
    }));
  });
}

const UNSET_DERIVED_RESULT = Symbol('unset runtime-state derived result');

export function updateRuntimeStateLockedDeriving<T>(
  projectRoot: string,
  reducer: (current: RuntimeState) => { state: RuntimeState; result: T },
): T {
  const lock = runtimeStateLock(projectRoot);
  const file = new AtomicJsonFile(runtimeStatePath(projectRoot), runtimeStatePersistenceSchema, lock, { version: 1 });
  let result: T | typeof UNSET_DERIVED_RESULT = UNSET_DERIVED_RESULT;
  lock.withLockSync((handle) => {
    if (!existsSync(runtimeStatePath(projectRoot))) {
      file.writeSync(handle, defaultRuntimeState());
    }
    file.updateSync(handle, (current) => {
      const reduced = reducer(current);
      result = reduced.result;
      return assertRuntimeStateInvariants(reduced.state);
    });
  });
  if (result === UNSET_DERIVED_RESULT) {
    throw new Error('Runtime state locked reducer did not set a result.');
  }
  return result;
}

function runtimeRecordId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export function appendRuntimeCommand(projectRoot: string, command: RuntimeCommandName, source: 'operator' | 'tool' | 'runtime' | 'analyst' = 'runtime'): RuntimeCommandRecord {
  const at = new Date().toISOString();
  const record: RuntimeCommandRecord = { command_id: runtimeRecordId('cmd'), command, status: 'accepted', requested_at: at, completed_at: null, source, error: null };
  return updateRuntimeStateLockedDeriving(projectRoot, (state) => ({
    state: { ...state, runtime_commands: [...state.runtime_commands, record], updated_at: at },
    result: record,
  }));
}

export function appendRuntimeRun(projectRoot: string, input: Omit<RuntimeRunRecord, 'run_id' | 'started_at' | 'updated_at'> & { run_id?: string; started_at?: string; updated_at?: string }): RuntimeRunRecord {
  const at = new Date().toISOString();
  const record: RuntimeRunRecord = { ...input, run_id: input.run_id ?? runtimeRecordId('run'), started_at: input.started_at ?? at, updated_at: input.updated_at ?? at };
  return updateRuntimeStateLockedDeriving(projectRoot, (state) => ({
    state: { ...state, runtime_runs: [...state.runtime_runs.filter((run) => run.run_id !== record.run_id), record], updated_at: at },
    result: record,
  }));
}

export function updateRuntimeRun(projectRoot: string, runId: string, changes: Partial<RuntimeRunRecord>): RuntimeRunRecord | null {
  const at = new Date().toISOString();
  return updateRuntimeStateLockedDeriving(projectRoot, (state) => {
    const existing = state.runtime_runs.find((run) => run.run_id === runId);
    if (!existing) return { state, result: null };
    const updated = { ...existing, ...changes, updated_at: at };
    return {
      state: { ...state, runtime_runs: state.runtime_runs.map((run) => run.run_id === runId ? updated : run), updated_at: at },
      result: updated,
    };
  });
}

export function upsertRuntimeActivation(projectRoot: string, input: Omit<RuntimeActivationRecord, 'activation_id' | 'requested_at' | 'updated_at'> & { activation_id?: string; requested_at?: string; updated_at?: string }): RuntimeActivationRecord {
  const at = new Date().toISOString();
  const record: RuntimeActivationRecord = { ...input, activation_id: input.activation_id ?? runtimeRecordId('act'), requested_at: input.requested_at ?? at, updated_at: input.updated_at ?? at };
  return updateRuntimeStateLockedDeriving(projectRoot, (state) => {
    const existing = input.activation_id
      ? state.runtime_activations.find((activation) => activation.activation_id === input.activation_id)
      : state.runtime_activations.find((activation) => activation.idempotency_key === input.idempotency_key && !['completed', 'failed', 'blocked', 'cancelled'].includes(activation.status));
    if (existing) {
      const updated = { ...existing, ...input, activation_id: existing.activation_id, requested_at: existing.requested_at, updated_at: at };
      return {
        state: { ...state, runtime_activations: state.runtime_activations.map((activation) => activation.activation_id === existing.activation_id ? updated : activation), updated_at: at },
        result: updated,
      };
    }
    return {
      state: { ...state, runtime_activations: [...state.runtime_activations, record], updated_at: at },
      result: record,
    };
  });
}
