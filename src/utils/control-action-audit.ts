import { appendFileSync, mkdirSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { redactSecrets } from './file-access-security.js';
import { controlActionAuditEntrySchema } from '../schemas/validators.js';
import type { ControlActionAuditEntry } from '../schemas/types.js';

function auditPath(projectRoot: string): string {
  return join(projectRoot, '.saivage', 'runtime', 'control-actions.jsonl');
}

export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(obj[key])}`).join(',')}}`;
}

export function previewHashParams(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((item) => previewHashParams(item));
  const { confirmed: _confirmed, preview_hash: _previewHash, ...rest } = value as Record<string, unknown>;
  return Object.fromEntries(Object.entries(rest).map(([key, entryValue]) => [key, previewHashParams(entryValue)]));
}

export function hashPreviewParams(value: unknown): string {
  return createHash('sha256').update(stableStringify(previewHashParams(value))).digest('hex');
}

export function recordControlAction(projectRoot: string, entry: Omit<ControlActionAuditEntry, 'id' | 'created_at'> & { id?: string; created_at?: string }): ControlActionAuditEntry {
  const parsed = controlActionAuditEntrySchema.parse({
    ...entry,
    id: entry.id ?? randomUUID(),
    created_at: entry.created_at ?? new Date().toISOString(),
    params_summary: redactSecrets(entry.params_summary),
    error: entry.error ? redactSecrets(entry.error) : undefined,
  });
  const path = auditPath(projectRoot);
  mkdirSync(join(path, '..'), { recursive: true });
  appendFileSync(path, `${JSON.stringify(parsed)}\n`, 'utf-8');
  return parsed;
}
