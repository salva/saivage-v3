import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import type { ZodType } from 'zod';
import type { ApplicationPersistenceHealth } from '../application/persistence-health.js';
import type { ReadModelChanges } from '../application/read-model-changes.js';
import { cleanupDurableReplacementTemporaries, durablyReplaceFile } from '../persistence/durable-file-replacement.js';
import { IndeterminatePublicationError, PersistenceReadError, PersistenceValidationError, PersistenceVersionMismatch } from '../persistence/errors.js';
import { runtimeStateFile as layoutRuntimeStateFile } from '../persistence/layout.js';
import { runtimeStateSchema, type RuntimeState } from '../schemas/index.js';
import { createDefaultRuntimeState } from './default-state.js';

const runtimeStatePersistenceSchema = runtimeStateSchema as ZodType<RuntimeState>;

export class RuntimeStateInvariantError extends Error { constructor(message: string) { super(message); this.name = 'RuntimeStateInvariantError'; } }
export class RuntimeActivationInvariantError extends RuntimeStateInvariantError { constructor(message: string) { super(message); this.name = 'RuntimeActivationInvariantError'; } }
export class RuntimeDispatchInvariantError extends RuntimeStateInvariantError { constructor(message: string) { super(message); this.name = 'RuntimeDispatchInvariantError'; } }

export function runtimeStatePath(projectRoot: string): string { return layoutRuntimeStateFile(projectRoot); }

function assertRuntimeStateInvariants(state: RuntimeState): RuntimeState {
  if ((state.status !== 'stopped' && state.status !== 'paused') || state.active_card_run === null) return state;
  const status = state.active_card_run?.runtime_status ?? 'null';
  const cardId = state.active_card_run?.card_id ?? 'null';
  throw new RuntimeStateInvariantError(`RuntimeState invariant violation: ${state.status} runtime cannot retain active_card_run (card_id=${cardId}, runtime_status=${status}). Reset .saivage runtime state and restart.`);
}

export function readRuntimeState(projectRoot: string): RuntimeState | null {
  const path = runtimeStatePath(projectRoot);
  if (!existsSync(path)) return null;
  let json: unknown;
  try { json = JSON.parse(readFileSync(path, 'utf8')) as unknown; }
  catch (error) { throw new PersistenceReadError(path, 'malformed JSON; reset .saivage runtime state and restart', { cause: error }); }
  if (!json || typeof json !== 'object' || !('version' in json) || !('data' in json)) throw new PersistenceVersionMismatch(path, 1, 'missing');
  if ((json as { version: unknown }).version !== 1) throw new PersistenceVersionMismatch(path, 1, (json as { version: unknown }).version);
  const parsed = runtimeStatePersistenceSchema.safeParse((json as { data: unknown }).data);
  if (!parsed.success) throw new PersistenceValidationError(path, parsed.error.message);
  return assertRuntimeStateInvariants(parsed.data);
}

export class RuntimeStateStore {
  constructor(readonly projectRoot: string, private readonly health: ApplicationPersistenceHealth, private readonly changes?: ReadModelChanges) {}

  restabilize(): void {
    const directory = dirname(runtimeStatePath(this.projectRoot));
    if (existsSync(directory)) cleanupDurableReplacementTemporaries(directory, [basename(runtimeStatePath(this.projectRoot))]);
    readRuntimeState(this.projectRoot);
  }

  initialize(): RuntimeState {
    const existing = readRuntimeState(this.projectRoot);
    if (existing) return existing;
    return this.replace(createDefaultRuntimeState(), false);
  }

  read(): RuntimeState | null { return readRuntimeState(this.projectRoot); }

  patch(changes: Partial<RuntimeState>, publish = true): RuntimeState {
    const current = this.read();
    if (!current) throw new Error('Runtime state is not initialized. Start Saivage once before using runtime controls.');
    return this.replace({ ...current, ...changes, updated_at: new Date().toISOString() }, publish);
  }

  replace(state: RuntimeState, publish = true): RuntimeState {
    this.health.assertMutationHealthy();
    const parsed = runtimeStatePersistenceSchema.safeParse(state);
    if (!parsed.success) throw new PersistenceValidationError(runtimeStatePath(this.projectRoot), parsed.error.message);
    const validated = assertRuntimeStateInvariants(parsed.data);
    try { mkdirSync(dirname(runtimeStatePath(this.projectRoot)), { recursive: true }); durablyReplaceFile(runtimeStatePath(this.projectRoot), Buffer.from(JSON.stringify({ version: 1, data: validated }, null, 2) + '\n')); }
    catch (error) {
      if (error instanceof IndeterminatePublicationError) this.health.reportUncertainFailure({ target: runtimeStatePath(this.projectRoot), operation: 'replace runtime state', error });
      throw error;
    }
    if (publish) this.changes?.runtimeChanged();
    return validated;
  }
}
