import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import type { ZodType } from 'zod';
import type { CompositionMutationAuthority, MutationAuthority } from '../application/mutation-authority.js';
import type { MutationLane } from '../application/mutation-lane.js';
import type { ReadModelChanges } from '../application/read-model-changes.js';
import { cleanupDurableReplacementTemporaries, durablyReplaceFile } from '../persistence/durable-file-replacement.js';
import { PersistenceReadError, PersistenceValidationError, PersistenceVersionMismatch } from '../persistence/errors.js';
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
  #failed = false;
  constructor(readonly projectRoot: string, private readonly lane: MutationLane, private readonly changes?: ReadModelChanges) {}

  restabilize(authority: CompositionMutationAuthority): void {
    const result = this.lane.apply(authority, 'runtime state restabilization', () => {
      const directory = dirname(runtimeStatePath(this.projectRoot));
      if (existsSync(directory)) cleanupDurableReplacementTemporaries(directory, [basename(runtimeStatePath(this.projectRoot))]);
      readRuntimeState(this.projectRoot);
    });
    if (!result.applied) throw new Error('Composition authority unexpectedly became stale.');
  }

  initialize(authority: CompositionMutationAuthority): RuntimeState {
    const existing = readRuntimeState(this.projectRoot);
    if (existing) return existing;
    return this.replace(authority, createDefaultRuntimeState(), false);
  }

  read(): RuntimeState | null { return readRuntimeState(this.projectRoot); }

  patch(authority: MutationAuthority, changes: Partial<RuntimeState>, publish = true): RuntimeState {
    const current = this.read();
    if (!current) throw new Error('Runtime state is not initialized. Start Saivage once before using runtime controls.');
    return this.replace(authority, { ...current, ...changes, updated_at: new Date().toISOString() }, publish);
  }

  replace(authority: MutationAuthority, state: RuntimeState, publish = true): RuntimeState {
    if (this.#failed) throw new Error('Runtime state store has failed and requires restart.');
    const parsed = runtimeStatePersistenceSchema.safeParse(state);
    if (!parsed.success) throw new PersistenceValidationError(runtimeStatePath(this.projectRoot), parsed.error.message);
    const validated = assertRuntimeStateInvariants(parsed.data);
    const result = this.lane.apply(authority, 'runtime state replacement', () => {
      try { mkdirSync(dirname(runtimeStatePath(this.projectRoot)), { recursive: true }); durablyReplaceFile(runtimeStatePath(this.projectRoot), Buffer.from(JSON.stringify({ version: 1, data: validated }, null, 2) + '\n')); }
      catch (error) { this.#failed = true; throw error; }
      return validated;
    });
    if (!result.applied) throw new Error('Runtime state mutation authority is stale.');
    if (publish) this.changes?.runtimeChanged();
    return result.value;
  }
}
