import { randomUUID } from 'node:crypto';
import { redactForOutbound } from '../redaction/index.js';
import { controlActionAuditEntrySchema } from '../schemas/index.js';
import type { ControlActionAuditEntry } from '../schemas/index.js';
import { appendAppLogEntry, readAppLogEntries } from './app-log.js';

export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(obj[key])}`).join(',')}}`;
}

export function listControlActions(projectRoot: string, filters?: { card_id?: string; since?: string }): ControlActionAuditEntry[] {
  return readAppLogEntries(projectRoot, 'control_action')
    .map((entry) => entry.data)
    .map((entry) => redactForOutbound({ source: 'control-action', value: entry }))
    .filter((entry) => (filters?.card_id ? entry.target_id === filters.card_id : true))
    .filter((entry) => (filters?.since ? entry.created_at >= filters.since : true))
    .sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id));
}

export function recordControlAction(
  projectRoot: string,
  prepareEntry: () => Omit<ControlActionAuditEntry, 'id' | 'created_at'> & { id?: string; created_at?: string },
): ControlActionAuditEntry {
  return appendAppLogEntry(projectRoot, 'control_action', () => {
    const entry = prepareEntry();
    const parsed = controlActionAuditEntrySchema.parse({
      ...entry,
      id: entry.id ?? randomUUID(),
      created_at: entry.created_at ?? new Date().toISOString(),
    });
    return { type: 'control_action', data: redactForOutbound({ source: 'control-action', value: parsed }) };
  }).data;
}
