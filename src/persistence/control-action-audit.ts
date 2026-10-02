import { randomUUID } from 'node:crypto';
import { controlActionAuditEntrySchema } from '../schemas/index.js';
import type { ControlActionAuditEntry } from '../schemas/index.js';
import { appendAppLogEntry, readAppLogEntries } from './app-log.js';
import { projectControlAction } from './control-action-outbound.js';

export function listControlActions(
  projectRoot: string,
  filters?: { card_id?: string; since?: string },
): ControlActionAuditEntry[] {
  return readAppLogEntries(projectRoot, 'control_action')
    .map((entry) => entry.data)
    .map((entry) => projectControlAction(entry))
    .filter((entry) => (filters?.card_id ? entry.target_id === filters.card_id : true))
    .filter((entry) => (filters?.since ? entry.created_at >= filters.since : true))
    .sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id));
}

export function recordControlAction(
  projectRoot: string,
  prepareEntry: () => Omit<ControlActionAuditEntry, 'id' | 'created_at'> & {
    id?: string;
    created_at?: string;
  },
): ControlActionAuditEntry {
  return appendAppLogEntry(projectRoot, 'control_action', () => {
    const entry = prepareEntry();
    const parsed = controlActionAuditEntrySchema.parse({
      ...entry,
      id: entry.id ?? randomUUID(),
      created_at: entry.created_at ?? new Date().toISOString(),
    });
    return { type: 'control_action', data: projectControlAction(parsed) };
  }).data;
}
