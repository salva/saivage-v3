import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { runtimeStateSchema } from '../schemas/validators.js';
import { explainLegacyStateRejection, writeFileAtomic } from './file-tree.js';
import type { RuntimeState } from '../schemas/types.js';

const STATE_FILE = 'state.json';

function statePath(projectRoot: string): string {
  return join(projectRoot, '.saivage', 'runtime', STATE_FILE);
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
  };
}

function parseRuntimeState(projectRoot: string, raw: unknown): RuntimeState {
  const parsed = runtimeStateSchema.safeParse(raw);
  if (!parsed.success) {
    explainLegacyStateRejection(projectRoot, 'RuntimeState', parsed.error.message);
  }
  return parsed.data;
}

export function initRuntimeState(projectRoot: string): RuntimeState {
  const state = defaultRuntimeState();
  writeFileAtomic(statePath(projectRoot), JSON.stringify(state, null, 2) + '\n');
  return state;
}

export function saveRuntimeState(projectRoot: string, state: RuntimeState): RuntimeState {
  const parsed = runtimeStateSchema.safeParse(state);
  if (!parsed.success) {
    explainLegacyStateRejection(projectRoot, 'RuntimeState', parsed.error.message);
  }
  writeFileAtomic(statePath(projectRoot), JSON.stringify(parsed.data, null, 2) + '\n');
  return parsed.data;
}

export function readRuntimeState(projectRoot: string): RuntimeState | null {
  const sp = statePath(projectRoot);
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
