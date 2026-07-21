import { randomUUID } from 'node:crypto';
import { redactTextForOutbound } from '../redaction/index.js';
import { controlActionAuditEntrySchema } from '../schemas/index.js';
import type { ControlActionAuditEntry } from '../schemas/index.js';
import { appendAppLogEntry, readAppLogEntries } from './app-log.js';

const INLINE_SECRET_RE = /(api(?:[_-]?key|[_-]?token)?|token|secret|password)\s*=\s*("[^"]*"|'[^']*'|\S+)/gi;

export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(obj[key])}`).join(',')}}`;
}

function sanitizeAuditText(text: string): string {
  return redactTextForOutbound(text).replace(INLINE_SECRET_RE, (_match, key: string) => `${key}=[REDACTED]`);
}

export function listControlActions(projectRoot: string, filters?: { card_id?: string; since?: string }): ControlActionAuditEntry[] {
  return readAppLogEntries(projectRoot, 'control_action')
    .map((entry) => entry.data)
    .map((entry) => ({
      ...entry,
      params_summary: sanitizeAuditText(entry.params_summary),
      outcome_summary: sanitizeAuditText(entry.outcome_summary),
      error: entry.error ? sanitizeAuditText(entry.error) : undefined,
    }))
    .filter((entry) => (filters?.card_id ? entry.target_id === filters.card_id : true))
    .filter((entry) => (filters?.since ? entry.created_at >= filters.since : true))
    .sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id));
}

export function recordControlAction(
  projectRoot: string,
  prepareEntry: () => Omit<ControlActionAuditEntry, 'id' | 'created_at'> & { id?: string; created_at?: string },
  operationError?: unknown,
): ControlActionAuditEntry {
  return appendAppLogEntry(projectRoot, 'control_action', () => {
    const entry = prepareEntry();
    const parsed = controlActionAuditEntrySchema.parse({
      ...entry,
      id: entry.id ?? randomUUID(),
      created_at: entry.created_at ?? new Date().toISOString(),
      params_summary: sanitizeAuditText(entry.params_summary),
      outcome_summary: sanitizeAuditText(entry.outcome_summary),
      error: entry.error ? sanitizeAuditText(entry.error) : undefined,
    });
    return { type: 'control_action', data: parsed };
  }, { operationError }).data;
}
