import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { runtimeStateSchema } from '../schemas/validators.js';
import { writeFileAtomic } from './file-tree.js';
import type { RuntimeState } from '../schemas/types.js';

// ── Constants ─────────────────────────────────────────────────

const STATE_FILE = 'state.json';

function statePath(projectRoot: string): string {
  return join(projectRoot, '.saivage', 'runtime', STATE_FILE);
}

// ── Default State Factory ─────────────────────────────────────

function defaultRuntimeState(): RuntimeState {
  const now = new Date().toISOString();
  return {
    status: 'idle',
    project_id: 'project',
    pid: process.pid,
    started_at: now,
    current_card_id: null,
    current_agent_session_id: null,
    paused: false,
    paused_at: null,
    queue: [],
    running_processes: [],
    updated_at: now,
    frozen_reason: null,
  };
}

function normalizeRuntimeState(raw: unknown): RuntimeState {
  const base = defaultRuntimeState();
  const merged = {
    ...base,
    ...(raw && typeof raw === 'object' ? raw as Record<string, unknown> : {}),
    current_card_id: raw && typeof raw === 'object' && 'current_card_id' in (raw as Record<string, unknown>) ? (raw as Record<string, unknown>).current_card_id as string | null : base.current_card_id,
    current_agent_session_id: raw && typeof raw === 'object' && 'current_agent_session_id' in (raw as Record<string, unknown>) ? (raw as Record<string, unknown>).current_agent_session_id as string | null : base.current_agent_session_id,
    paused_at: raw && typeof raw === 'object' && 'paused_at' in (raw as Record<string, unknown>) ? (raw as Record<string, unknown>).paused_at as string | null : base.paused_at,
    queue: Array.isArray((raw as Record<string, unknown> | null)?.queue) ? (raw as Record<string, unknown>).queue as string[] : base.queue,
    running_processes: Array.isArray((raw as Record<string, unknown> | null)?.running_processes) ? (raw as Record<string, unknown>).running_processes as string[] : base.running_processes,
    frozen_reason: raw && typeof raw === 'object' && 'frozen_reason' in (raw as Record<string, unknown>) ? (raw as Record<string, unknown>).frozen_reason as string | null : base.frozen_reason,
  };
  const parsed = runtimeStateSchema.safeParse(merged);
  if (!parsed.success) {
    throw new Error(`RuntimeState validation failed: ${parsed.error.message}`);
  }
  return parsed.data;
}

// ── Public API ────────────────────────────────────────────────

/**
 * Initialize the runtime state file. Writes the default idle state
 * atomically. If a state file already exists, it is overwritten.
 *
 * @param projectRoot - Absolute path to the project root directory.
 * @returns The written RuntimeState.
 */
export function initRuntimeState(projectRoot: string): RuntimeState {
  const state = defaultRuntimeState();
  writeFileAtomic(statePath(projectRoot), JSON.stringify(state, null, 2) + '\n');
  return state;
}

/**
 * Save a RuntimeState object to .saivage/runtime/state.json atomically.
 * Validates against the Zod schema before writing.
 *
 * @param projectRoot - Absolute path to the project root directory.
 * @param state - The RuntimeState object to persist.
 * @returns The validated RuntimeState that was written.
 */
export function saveRuntimeState(projectRoot: string, state: RuntimeState): RuntimeState {
  const parsed = runtimeStateSchema.safeParse(state);
  if (!parsed.success) {
    throw new Error(`RuntimeState validation failed: ${parsed.error.message}`);
  }
  writeFileAtomic(statePath(projectRoot), JSON.stringify(parsed.data, null, 2) + '\n');
  return parsed.data;
}

/**
 * Read and validate the runtime state from .saivage/runtime/state.json.
 *
 * @param projectRoot - Absolute path to the project root directory.
 * @returns The validated RuntimeState, or null if the file does not exist.
 * @throws If the file exists but fails Zod validation.
 */
export function readRuntimeState(projectRoot: string): RuntimeState | null {
  const sp = statePath(projectRoot);
  if (!existsSync(sp)) {
    return null;
  }
  const raw = readFileSync(sp, 'utf-8');
  const obj = JSON.parse(raw);
  return normalizeRuntimeState(obj);
}

/**
 * Convenience: read existing state, update fields, and save atomically.
 * If no state exists, initializes a default state first.
 *
 * @param projectRoot - Absolute path to the project root directory.
 * @param changes - Partial RuntimeState fields to merge.
 * @returns The updated RuntimeState.
 */
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
