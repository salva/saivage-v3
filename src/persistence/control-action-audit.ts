import { existsSync, readFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { redactTextForOutbound } from '../redaction/index.js';
import { controlActionAuditEntrySchema } from '../schemas/index.js';
import type { ControlActionAuditEntry } from '../schemas/index.js';
import { EventBus } from '../events/index.js';
import { registerControlActionAuditProjection } from '../projections/index.js';

const INLINE_SECRET_RE = /(api(?:[_-]?key|[_-]?token)?|token|secret|password)\s*=\s*("[^"]*"|'[^']*'|\S+)/gi;

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

function sanitizeAuditText(text: string): string {
  return redactTextForOutbound(text, 'operator.api', { source: 'control-action-audit' }).replace(INLINE_SECRET_RE, (_match, key: string) => `${key}=[REDACTED]`);
}

function parseAuditEntry(line: string): ControlActionAuditEntry | null {
  try {
    const raw = JSON.parse(line) as Record<string, unknown>;
    const normalized = {
      ...raw,
      target_kind: raw.target_kind === undefined ? null : raw.target_kind,
      target_id: raw.target_id === undefined ? null : raw.target_id,
    };
    return controlActionAuditEntrySchema.parse(normalized);
  } catch {
    return null;
  }
}

export function listControlActions(projectRoot: string, filters?: { card_id?: string; since?: string }): ControlActionAuditEntry[] {
  const path = auditPath(projectRoot);
  if (!existsSync(path)) return [];
  const raw = readFileSync(path, 'utf-8').trim();
  if (!raw) return [];
  return raw
    .split('\n')
    .filter(Boolean)
    .map((line) => parseAuditEntry(line))
    .filter((entry): entry is ControlActionAuditEntry => entry !== null)
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

export function recordControlAction(projectRoot: string, entry: Omit<ControlActionAuditEntry, 'id' | 'created_at'> & { id?: string; created_at?: string }, eventBus = new EventBus()): ControlActionAuditEntry {
  const parsed = controlActionAuditEntrySchema.parse({
    ...entry,
    id: entry.id ?? randomUUID(),
    created_at: entry.created_at ?? new Date().toISOString(),
    params_summary: sanitizeAuditText(entry.params_summary),
    outcome_summary: sanitizeAuditText(entry.outcome_summary),
    error: entry.error ? sanitizeAuditText(entry.error) : undefined,
  });
  registerControlActionAuditProjection(eventBus, projectRoot);
  eventBus.emit('control_action_record_appended', { record: parsed as unknown as Record<string, unknown> });
  eventBus.emit('control_action_recorded', {
    id: parsed.id,
    action: parsed.action,
    target_kind: parsed.target_kind,
    target_id: parsed.target_id,
    outcome: parsed.outcome,
    created_at: parsed.created_at,
    actor: parsed.actor,
    surface: parsed.surface,
  });
  return parsed;
}
