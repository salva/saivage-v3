import type { RuntimeState } from '../schemas/index.js';

export function createDefaultRuntimeState(pid: number = process.pid, nowIso: string = new Date().toISOString()): RuntimeState {
  return {
    status: 'stopped',
    project_id: 'project',
    pid,
    started_at: nowIso,
    active_card_run: null,
    updated_at: nowIso,
    last_tick_at: null,
  };
}
