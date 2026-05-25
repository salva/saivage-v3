import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { runtimeStateSchema } from '../schemas/index.js';
import type { ZodType } from 'zod';
import { explainLegacyStateRejection } from '../persistence/index.js';
import { AtomicJsonFile, ProjectLock, PersistenceReadError, PersistenceValidationError } from '../persistence/index.js';
import type { ActiveCardRun, RuntimeActivationRecord, RuntimeCommandName, RuntimeCommandRecord, RuntimeRunRecord, RuntimeState } from '../schemas/index.js';

const LEGACY_STATE_FILE = 'state.json';
const AUTHORITATIVE_STATE_FILE = 'runtime.json';
const TERMINAL_IDLE_ACTIVE_RUN_STATUSES = new Set(['stopped', 'cancelled']);
const runtimeStatePersistenceSchema = runtimeStateSchema as ZodType<RuntimeState>;

export class RuntimeStateInvariantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RuntimeStateInvariantError';
  }
}

export class RuntimeStateLayoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RuntimeStateLayoutError';
  }
}

export function runtimeStatePath(projectRoot: string): string {
  return join(projectRoot, '.saivage', 'tmp', 'state', AUTHORITATIVE_STATE_FILE);
}

export function legacyRuntimeStatePath(projectRoot: string): string {
  return join(projectRoot, '.saivage', 'runtime', LEGACY_STATE_FILE);
}


function runtimeStateLock(projectRoot: string): ProjectLock {
  return new ProjectLock(join(projectRoot, '.saivage', '.lock'));
}

function runtimeStateFile(projectRoot: string): AtomicJsonFile<RuntimeState> {
  return new AtomicJsonFile(runtimeStatePath(projectRoot), runtimeStatePersistenceSchema, runtimeStateLock(projectRoot), { version: 1 });
}

function activeRunIsIdleTerminal(run: ActiveCardRun | null | undefined): boolean {
  if (!run) return true;
  return TERMINAL_IDLE_ACTIVE_RUN_STATUSES.has(run.runtime_status);
}

function isIdleWithoutCurrentCard(state: RuntimeState): boolean {
  return state.status === 'idle' && (state.current_card_id ?? null) === null;
}

function describeInvariantViolation(state: RuntimeState): string {
  const status = state.active_card_run?.runtime_status ?? 'null';
  const cardId = state.active_card_run?.card_id ?? 'null';
  return `RuntimeState invariant violation: idle runtime with current_card_id null cannot retain non-terminal active_card_run (card_id=${cardId}, runtime_status=${status}). Reset .saivage runtime state and restart.`;
}

function describeMixedLayout(projectRoot: string): string {
  return `RuntimeState layout conflict: both authoritative ${runtimeStatePath(projectRoot)} and legacy ${legacyRuntimeStatePath(projectRoot)} exist. Current runtime state only supports ${runtimeStatePath(projectRoot)}; reset .saivage runtime state and restart.`;
}

function assertNoMixedRuntimeStateLayout(projectRoot: string): void {
  if (existsSync(runtimeStatePath(projectRoot)) && existsSync(legacyRuntimeStatePath(projectRoot))) {
    throw new RuntimeStateLayoutError(describeMixedLayout(projectRoot));
  }
}

function assertRuntimeStateInvariants(state: RuntimeState): RuntimeState {
  if (!isIdleWithoutCurrentCard(state) || activeRunIsIdleTerminal(state.active_card_run)) {
    return state;
  }
  throw new RuntimeStateInvariantError(describeInvariantViolation(state));
}

function defaultRuntimeState(): RuntimeState {
  const now = new Date().toISOString();
  return {
    status: 'idle',
    project_id: 'project',
    pid: process.pid,
    started_at: now,
    current_card_id: null,
    current_agent_session_id: null,
    active_card_run: null,
    paused: false,
    paused_at: null,
    queue: [],
    running_processes: [],
    updated_at: now,
    last_tick_at: null,
    frozen_reason: null,
    runtime_intent: { status: 'stopped', updated_at: now, source_command_id: null, reason: 'default stopped intent until explicit start_project command' },
    runtime_commands: [],
    runtime_runs: [],
    runtime_activations: [],
  };
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
  assertNoMixedRuntimeStateLayout(projectRoot);
  const state = defaultRuntimeState();
  const lock = runtimeStateLock(projectRoot);
  const file = new AtomicJsonFile(runtimeStatePath(projectRoot), runtimeStatePersistenceSchema, lock, { version: 1 });
  lock.withLockSync((handle) => file.writeSync(handle, state));
  return state;
}

export function saveRuntimeState(projectRoot: string, state: RuntimeState): RuntimeState {
  assertNoMixedRuntimeStateLayout(projectRoot);
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
  assertNoMixedRuntimeStateLayout(projectRoot);
  if (!existsSync(runtimeStatePath(projectRoot))) {
    return null;
  }
  return readRuntimeStateFile(projectRoot);
}

export function updateRuntimeState(
  projectRoot: string,
  changes: Partial<RuntimeState>,
): RuntimeState {
  assertNoMixedRuntimeStateLayout(projectRoot);
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

function runtimeRecordId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function ensureRuntimeState(projectRoot: string): RuntimeState {
  return readRuntimeState(projectRoot) ?? initRuntimeState(projectRoot);
}

export function appendRuntimeCommand(projectRoot: string, command: RuntimeCommandName, source: 'operator' | 'tool' | 'runtime' | 'analyst' = 'runtime'): RuntimeCommandRecord {
  const state = ensureRuntimeState(projectRoot);
  const at = new Date().toISOString();
  const record: RuntimeCommandRecord = { command_id: runtimeRecordId('cmd'), command, status: 'accepted', requested_at: at, completed_at: null, source, error: null };
  saveRuntimeState(projectRoot, { ...state, runtime_commands: [...(state.runtime_commands ?? []), record], updated_at: at });
  return record;
}

export function upsertRuntimeIntent(projectRoot: string, status: NonNullable<RuntimeState['runtime_intent']>['status'], sourceCommandId: string | null, reason?: string): RuntimeState {
  const state = ensureRuntimeState(projectRoot);
  const at = new Date().toISOString();
  return saveRuntimeState(projectRoot, { ...state, runtime_intent: { status, updated_at: at, source_command_id: sourceCommandId, reason: reason ?? null }, updated_at: at });
}

export function appendRuntimeRun(projectRoot: string, input: Omit<RuntimeRunRecord, 'run_id' | 'started_at' | 'updated_at'> & { run_id?: string; started_at?: string; updated_at?: string }): RuntimeRunRecord {
  const state = ensureRuntimeState(projectRoot);
  const at = new Date().toISOString();
  const record: RuntimeRunRecord = { ...input, run_id: input.run_id ?? runtimeRecordId('run'), started_at: input.started_at ?? at, updated_at: input.updated_at ?? at };
  saveRuntimeState(projectRoot, { ...state, runtime_runs: [...(state.runtime_runs ?? []).filter((run) => run.run_id !== record.run_id), record], updated_at: at });
  return record;
}

export function updateRuntimeRun(projectRoot: string, runId: string, changes: Partial<RuntimeRunRecord>): RuntimeRunRecord | null {
  const state = ensureRuntimeState(projectRoot);
  const existing = (state.runtime_runs ?? []).find((run) => run.run_id === runId);
  if (!existing) return null;
  const at = new Date().toISOString();
  const updated = { ...existing, ...changes, updated_at: at };
  saveRuntimeState(projectRoot, { ...state, runtime_runs: (state.runtime_runs ?? []).map((run) => run.run_id === runId ? updated : run), updated_at: at });
  return updated;
}

export function upsertRuntimeActivation(projectRoot: string, input: Omit<RuntimeActivationRecord, 'activation_id' | 'requested_at' | 'updated_at'> & { activation_id?: string; requested_at?: string; updated_at?: string }): RuntimeActivationRecord {
  const state = ensureRuntimeState(projectRoot);
  const existing = (state.runtime_activations ?? []).find((activation) => activation.idempotency_key === input.idempotency_key && !['completed', 'failed', 'blocked', 'cancelled'].includes(activation.status));
  if (existing) return existing;
  const at = new Date().toISOString();
  const record: RuntimeActivationRecord = { ...input, activation_id: input.activation_id ?? runtimeRecordId('act'), requested_at: input.requested_at ?? at, updated_at: input.updated_at ?? at };
  saveRuntimeState(projectRoot, { ...state, runtime_activations: [...(state.runtime_activations ?? []), record], updated_at: at });
  return record;
}
