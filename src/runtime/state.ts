import { readFileSync, existsSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { runtimeStateSchema } from '../schemas/validators.js';
import { explainLegacyStateRejection, writeFileAtomic } from '../utils/file-tree.js';
import { EventLogger } from '../utils/event-logger.js';
import type { ActiveCardRun, RuntimeActivationRecord, RuntimeCommandName, RuntimeCommandRecord, RuntimeRunRecord, RuntimeState } from '../schemas/types.js';

const LEGACY_STATE_FILE = 'state.json';
const AUTHORITATIVE_STATE_FILE = 'runtime.json';
const TERMINAL_IDLE_ACTIVE_RUN_STATUSES = new Set(['stopped', 'cancelled']);

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

function migratedLegacyRuntimeStatePath(projectRoot: string): string {
  return join(projectRoot, '.saivage', 'runtime', `${LEGACY_STATE_FILE}.migrated`);
}

function isProductionRuntime(): boolean {
  return process.env['NODE_ENV'] === 'production';
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
  return `RuntimeState invariant violation: idle runtime with current_card_id null cannot retain non-terminal active_card_run (card_id=${cardId}, runtime_status=${status}).`;
}

function describeMixedLayout(projectRoot: string): string {
  return `RuntimeState layout conflict: both authoritative ${runtimeStatePath(projectRoot)} and legacy ${legacyRuntimeStatePath(projectRoot)} exist. Refusing to choose between split-brain state files; move the legacy file aside after confirming the authoritative state is correct.`;
}

function assertNoMixedRuntimeStateLayout(projectRoot: string): void {
  if (existsSync(runtimeStatePath(projectRoot)) && existsSync(legacyRuntimeStatePath(projectRoot))) {
    throw new RuntimeStateLayoutError(describeMixedLayout(projectRoot));
  }
}

function migrateLegacyRuntimeStateIfNeeded(projectRoot: string): void {
  const authoritativePath = runtimeStatePath(projectRoot);
  const legacyPath = legacyRuntimeStatePath(projectRoot);
  if (existsSync(authoritativePath)) {
    assertNoMixedRuntimeStateLayout(projectRoot);
    return;
  }
  if (!existsSync(legacyPath)) return;

  const raw = readFileSync(legacyPath, 'utf-8');
  const state = parseRuntimeState(projectRoot, JSON.parse(raw), { persistSelfHeal: false });
  writeFileAtomic(authoritativePath, JSON.stringify(state, null, 2) + '\n');
  renameSync(legacyPath, migratedLegacyRuntimeStatePath(projectRoot));
}

function appendSelfHealWarning(projectRoot: string, state: RuntimeState, source: 'save' | 'read'): void {
  let logger: EventLogger | null = null;
  try {
    logger = new EventLogger(join(projectRoot, '.saivage'));
    logger.appendEvent({
      kind: 'error',
      phase: 'runtime_state_invariant',
      card_id: state.active_card_run?.card_id,
      error_message: `${describeInvariantViolation(state)} Auto-cleared active_card_run during ${source}.`,
      severity: 'warning',
      self_healed: true,
    });
    logger.flushSync();
  } catch {
    // State self-healing must not be blocked by event logging failures.
  } finally {
    logger?.close();
  }
}

function normalizeRuntimeStateInvariant(
  projectRoot: string,
  state: RuntimeState,
  source: 'save' | 'read',
): RuntimeState {
  if (!isIdleWithoutCurrentCard(state) || activeRunIsIdleTerminal(state.active_card_run)) {
    return state;
  }

  if (!isProductionRuntime()) {
    throw new RuntimeStateInvariantError(describeInvariantViolation(state));
  }

  appendSelfHealWarning(projectRoot, state, source);
  return {
    ...state,
    active_card_run: null,
    current_agent_session_id: null,
    running_processes: [],
    updated_at: new Date().toISOString(),
  };
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
    frozen_reason: null,
    runtime_intent: { status: 'stopped', updated_at: now, source_command_id: null, reason: 'default stopped intent until explicit start_project command' },
    runtime_commands: [],
    runtime_runs: [],
    runtime_activations: [],
  };
}

function parseRuntimeState(
  projectRoot: string,
  raw: unknown,
  options: { persistSelfHeal?: boolean } = {},
): RuntimeState {
  const rawRecord = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
  const normalizedRaw = {
    ...rawRecord,
    runtime_intent: rawRecord.runtime_intent ?? { status: 'stopped', updated_at: typeof rawRecord.updated_at === 'string' ? rawRecord.updated_at : new Date().toISOString(), source_command_id: null, reason: 'Wave 1 migration from pre-ledger runtime state' },
    runtime_commands: Array.isArray(rawRecord.runtime_commands) ? rawRecord.runtime_commands : [],
    runtime_runs: Array.isArray(rawRecord.runtime_runs) ? rawRecord.runtime_runs : [],
    runtime_activations: Array.isArray(rawRecord.runtime_activations) ? rawRecord.runtime_activations : [],
  };
  const parsed = runtimeStateSchema.safeParse(normalizedRaw);
  if (!parsed.success) {
    explainLegacyStateRejection(projectRoot, 'RuntimeState', parsed.error.message);
  }
  const normalized = normalizeRuntimeStateInvariant(projectRoot, parsed.data, 'read');
  if (options.persistSelfHeal !== false && normalized !== parsed.data) {
    writeFileAtomic(runtimeStatePath(projectRoot), JSON.stringify(normalized, null, 2) + '\n');
  }
  return normalized;
}

export function initRuntimeState(projectRoot: string): RuntimeState {
  assertNoMixedRuntimeStateLayout(projectRoot);
  const state = defaultRuntimeState();
  writeFileAtomic(runtimeStatePath(projectRoot), JSON.stringify(state, null, 2) + '\n');
  return state;
}

export function saveRuntimeState(projectRoot: string, state: RuntimeState): RuntimeState {
  assertNoMixedRuntimeStateLayout(projectRoot);
  const parsed = runtimeStateSchema.safeParse({
    ...(state as unknown as Record<string, unknown>),
    runtime_intent: state.runtime_intent ?? { status: 'stopped', updated_at: typeof state.updated_at === 'string' ? state.updated_at : new Date().toISOString(), source_command_id: null, reason: 'bounded save-time ledger default for legacy-shaped runtime state writer' },
    runtime_commands: Array.isArray(state.runtime_commands) ? state.runtime_commands : [],
    runtime_runs: Array.isArray(state.runtime_runs) ? state.runtime_runs : [],
    runtime_activations: Array.isArray(state.runtime_activations) ? state.runtime_activations : [],
  });
  if (!parsed.success) {
    explainLegacyStateRejection(projectRoot, 'RuntimeState', parsed.error.message);
  }
  const normalized = normalizeRuntimeStateInvariant(projectRoot, parsed.data, 'save');
  writeFileAtomic(runtimeStatePath(projectRoot), JSON.stringify(normalized, null, 2) + '\n');
  return normalized;
}

export function readRuntimeState(projectRoot: string): RuntimeState | null {
  migrateLegacyRuntimeStateIfNeeded(projectRoot);
  assertNoMixedRuntimeStateLayout(projectRoot);
  const sp = runtimeStatePath(projectRoot);
  if (!existsSync(sp)) {
    return null;
  }
  const raw = readFileSync(sp, 'utf-8');
  return parseRuntimeState(projectRoot, JSON.parse(raw));
}

export function updateRuntimeState(
  projectRoot: string,
  changes: Partial<RuntimeState>,
): RuntimeState {
  let current = readRuntimeState(projectRoot);
  if (!current) {
    current = initRuntimeState(projectRoot);
  }
  const updated: RuntimeState = {
    ...current,
    ...changes,
    updated_at: new Date().toISOString(),
  };
  return saveRuntimeState(projectRoot, updated);
}


function runtimeRecordId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function ensureRuntimeState(projectRoot: string): RuntimeState {
  return readRuntimeState(projectRoot) ?? initRuntimeState(projectRoot);
}

export function appendRuntimeCommand(projectRoot: string, command: RuntimeCommandName, source: 'operator' | 'tool' | 'runtime' = 'runtime'): RuntimeCommandRecord {
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
