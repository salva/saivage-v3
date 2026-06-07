import { parseToolCallMessage } from '../persistedToolCall';
import type { InlinePart, ResultPresenterContext, ToolCallMessage } from './types';

export function safeJsonParse(content: string): unknown {
  try { return JSON.parse(content) as unknown; } catch { return null; }
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

export function str(value: unknown): string {
  return typeof value === 'string' ? value : value === undefined || value === null ? '' : String(value);
}

export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, Math.max(0, max - 1)) + '…';
}

export function oneLine(value: unknown, max = 72): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? '');
  return truncate(text.replace(/\s+/g, ' '), max);
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return `${bytes} B`;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} kB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function shortPath(path: string): string { return path ? truncate(path, 64) : ''; }

export function argKeys(args: unknown): string {
  const record = asRecord(args);
  return record ? Object.keys(record).join(', ') : '';
}

export function textPart(text: unknown, max?: number): InlinePart[] {
  const value = max ? oneLine(text, max) : str(text);
  return value ? [{ kind: 'text', text: value }] : [];
}

export function cardPart(idValue: unknown, fallbackLabel?: string): InlinePart[] {
  const id = str(idValue);
  return id ? [{ kind: 'card', id, fallbackLabel: fallbackLabel ?? `card ${id}` }] : [];
}

export function appendText(parts: InlinePart[], text: unknown): InlinePart[] {
  const value = str(text);
  return value ? [...parts, { kind: 'text', text: value }] : parts;
}

export function filePart(pathValue: unknown, label?: string): InlinePart | null {
  const path = str(pathValue);
  if (path.startsWith('.saivage-work/')) return { kind: 'file', root: 'output', path, label: label ?? shortPath(path) };
  if (path.startsWith('.saivage/')) return { kind: 'file', root: 'meta', path, label: label ?? shortPath(path) };
  return null;
}

export function pathParts(pathValue: unknown): InlinePart[] {
  const path = str(pathValue);
  if (!path) return [];
  const file = filePart(path);
  return [file ?? { kind: 'text', text: shortPath(path) }];
}

export function readToolCallMessage(rawContent: string): ToolCallMessage {
  const row = JSON.parse(rawContent);
  const call = parseToolCallMessage(row);
  return { name: call.name, args: call.args };
}

export function describeCardOutcome(ctx: ResultPresenterContext, defaultVerb: string): { headline: InlinePart[]; detail?: InlinePart[] } {
  const record = ctx.record;
  const card = asRecord(record?.card);
  const id = str(card?.id ?? record?.cardId ?? record?.id);
  const status = str(card?.status ?? record?.status);
  const summary = str(record?.summary ?? record?.message);
  if (summary) return { headline: textPart(summary, 96), detail: status || id ? (status ? textPart(status) : cardPart(id)) : undefined };
  if (id) return { headline: [{ kind: 'text', text: `${defaultVerb} ` }, ...cardPart(id)], detail: status ? textPart(status) : undefined };
  return { headline: textPart(defaultVerb) };
}

export function describeJsonlTail(ctx: ResultPresenterContext, label: string): { headline: InlinePart[] } {
  const entries = Array.isArray(ctx.record?.entries) ? ctx.record!.entries : Array.isArray(ctx.parsed) ? ctx.parsed as unknown[] : null;
  return { headline: entries ? textPart(`${entries.length} ${label}`) : textPart(ctx.rawContent, 96) };
}

export function resultName(rawContent: string, fallbackName?: string): string {
  const record = asRecord(safeJsonParse(rawContent));
  return fallbackName
    ?? (typeof record?.tool === 'string' ? record.tool : undefined)
    ?? (typeof record?.toolName === 'string' ? record.toolName : undefined)
    ?? 'tool';
}
