import { parseToolCallMessage } from '../persistedToolCall';
import { parseScopedPathUrl, buildScopedPathUrl } from '@saivage/contracts/scoped-path-url';
import { parseRecordUrl } from '@saivage/contracts/record-mutation';
import { cardIdSchema } from '@saivage/schemas/card-id';
import type { InlinePart, ToolCallMessage } from './types';

export function safeJsonParse(content: string): unknown {
  try { return JSON.parse(content) as unknown; } catch { return null; }
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

export function str(value: unknown): string {
  return typeof value === 'string' ? value : value === undefined || value === null ? '' : String(value);
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, Math.max(0, max - 1)) + '…';
}

export function oneLine(value: unknown, max = 72): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? '');
  return truncate(text.replace(/\s+/g, ' '), max);
}

// Display labels only: never use an abbreviated label as a resource destination.
export function pathLabel(value: unknown, max = 48): string {
  const text = str(value).replace(/\s+/g, ' ');
  if (text.length <= max) return text;
  const queryAt = text.indexOf('?');
  if (queryAt >= 0 && max > 24) return `${pathLabel(text.slice(0, queryAt), max - 13)}?${oneLine(text.slice(queryAt + 1), 12)}`;
  if (!text.includes('/')) return `${text.slice(0, max - 9)}…${text.slice(-8)}`;
  const tail = text.slice(text.lastIndexOf('/') + 1);
  const tailBudget = Math.min(max - Math.min(12, Math.floor(max / 3)) - 1, tail.length);
  const labelTail = tail.length <= tailBudget ? tail
    : `${tail.slice(0, tailBudget - 9)}…${tail.slice(-8)}`;
  return `${text.slice(0, max - labelTail.length - 1)}…${labelTail}`;
}

export function summaryPathParts(value: unknown): InlinePart[] {
  return pathParts(value).map((part) => part.kind === 'file'
    ? { ...part, label: pathLabel(value) } : { kind: 'text', text: pathLabel(value) });
}

export function urlLabel(value: unknown): string {
  const text = str(value);
  if (text.length <= 48) return text;
  const withoutQuery = text.split(/[?#]/, 1)[0];
  const label = withoutQuery.replace(/^https?:\/\//, '');
  return pathLabel(`${label}${withoutQuery.length < text.length ? '…' : ''}`);
}

export function textPart(text: unknown, max?: number): InlinePart[] {
  const value = max ? oneLine(text, max) : str(text);
  return value ? [{ kind: 'text', text: value }] : [];
}

export function cardPart(idValue: unknown, fallbackLabel?: string): InlinePart[] {
  const id = str(idValue);
  if (!id) return [];
  return cardIdSchema.safeParse(id).success ? [{ kind: 'card', id, fallbackLabel: fallbackLabel ?? id }] : textPart(id);
}

function filePart(pathValue: unknown, label?: string): InlinePart | null {
  const path = str(pathValue);
  if (path.startsWith('record:///')) {
    try { parseRecordUrl(path); } catch { return null; }
    return { kind: 'file', root: 'meta', path, label: label ?? path };
  }
  if (path.startsWith('work:///')) {
    let parsed;
    try { parsed = parseScopedPathUrl(path, 'work'); } catch { return null; }
    if (parsed.query !== null || parsed.hadFragment || buildScopedPathUrl('work', parsed.segments) !== path) return null;
    return { kind: 'file', root: 'output', path: `.saivage/work/${parsed.segments.join('/')}`, label: label ?? path };
  }
  if (path.startsWith('.saivage/work/')) return { kind: 'file', root: 'output', path, label: label ?? path };
  if (path.startsWith('.saivage/cards/')) return { kind: 'file', root: 'meta', path, label: label ?? path };
  return null;
}

export function webfetchContentPart(value: unknown): InlinePart | null {
  const url = str(value);
  const match = /^work:\/\/\/tmp\/stash\/(webfetch-[1-9][0-9]*-[0-9a-f]{16}\.txt)$/u.exec(url);
  if (!match || match[0] !== url) return null;
  const file = match[1];
  return { kind: 'file', root: 'output', path: `.saivage/work/tmp/stash/${file}`, label: url };
}

export function processLogPart(value: unknown, stream: 'stdout' | 'stderr'): InlinePart | null {
  const url = str(value);
  const match = /^work:\/\/\/((?:cards\/(?:project|card-[a-z]+(?:-[a-z]+){0,11})\/)?processes\/proc-[0-9a-f]{12}\/(stdout|stderr)\.log)$/u.exec(url);
  if (!match || match[0] !== url || match[2] !== stream) return null;
  return { kind: 'file', root: 'output', path: `.saivage/work/${match[1]}`, label: `${stream} Files` };
}

export function pathParts(pathValue: unknown): InlinePart[] {
  const path = str(pathValue);
  if (!path) return [];
  const file = filePart(path);
  return [file ?? { kind: 'text', text: path }];
}

export function readToolCallMessage(rawContent: string): ToolCallMessage {
  const row = JSON.parse(rawContent);
  const call = parseToolCallMessage(row);
  return { name: call.name, args: call.args };
}
