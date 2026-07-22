import { join } from 'node:path';

import { PROJECT_CARD_ID, type CardService } from '../cards/card-api.js';
import { computeCardLogicalPath } from '../application/read-models/card-view.js';
import type { CardRecord, CardType } from '../schemas/index.js';
import { CARD_STATUS_VALUES, CARD_TYPE_VALUES, URGENCY_VALUES } from './tool-definition.js';
import type { SafeToolData, ToolContext, ToolResult } from './analyst-tool-types.js';
import { rethrowAppLogPublicationError } from '../persistence/app-log.js';

export function saivageDir(projectRoot: string): string {
  return join(projectRoot, '.saivage');
}

export function getStore(ctx: ToolContext): CardService {
  return ctx.store;
}

export function cardSummary(card: CardRecord, store?: CardService) {
  return { id: card.id, logical_path: store ? computeCardLogicalPath(store, card) : null, title: card.title, type: card.type, status: card.lifecycle.status };
}

export function normalizeParentValue(value: unknown): string | null | undefined {
  if (value === null) return null;
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (trimmed.toLowerCase() === 'null') return null;
  return trimmed;
}

export function defaultParentForCreate(store: CardService, type: CardType): string | null | undefined {
  if (type === 'project') return null;
  if (type === 'goal') return PROJECT_CARD_ID;
  const activeGoals = store
    .list()
    .filter((card) => card.type === 'goal' && ['running', 'backlog', 'blocked', 'stopped'].includes(card.lifecycle.status))
    .sort((a, b) => a.priority - b.priority);
  if (activeGoals.length === 1) return activeGoals[0].id;
  const allGoals = store
    .list()
    .filter((card) => card.type === 'goal')
    .sort((a, b) => a.priority - b.priority);
  if (allGoals.length === 1) return allGoals[0].id;
  return PROJECT_CARD_ID;
}

export function humanizeToolError(toolName: string, raw: string): string {
  const enumHints: string[] = [];
  const enumIssueRe = /"received":\s*"([^"]*)"[\s\S]*?"path":\s*\[\s*"([^"]+)"[\s\S]*?Expected\s+([^,]+(?:\s*\|\s*[^,]+)+)/g;
  let m: RegExpExecArray | null;
  while ((m = enumIssueRe.exec(raw)) !== null) {
    const got = m[1];
    const field = m[2];
    const allowed = m[3]
      .replace(/'/g, '')
      .split('|')
      .map((s) => s.trim())
      .filter(Boolean)
      .join(', ');
    enumHints.push(`field '${field}' received '${got}'; allowed values: ${allowed}`);
  }
  if (enumHints.length === 0) {
    if (/\bstatus\b/i.test(raw)) enumHints.push(`'status' allowed values: ${CARD_STATUS_VALUES.join(', ')}`);
    else if (/\burgency\b/i.test(raw)) enumHints.push(`'urgency' allowed values: ${URGENCY_VALUES.join(', ')}`);
    else if (/\btype\b/i.test(raw)) enumHints.push(`'type' allowed values: ${CARD_TYPE_VALUES.join(', ')}`);
  }
  const hintLine = enumHints.length > 0 ? ` Hint: ${enumHints.join('; ')}.` : '';
  return `${toolName} failed.${hintLine} See the '${toolName}' tool's parameter schema for the full list of accepted fields and values. Original error: ${raw}`;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function toolFailure(message: string, safeData?: SafeToolData): ToolResult {
  return safeData === undefined ? { success: false, error: message } : { success: false, error: message, data: safeData };
}

export function toolFailureFromError(err: unknown, messageOverride?: string): ToolResult {
  rethrowAppLogPublicationError(err);
  return { success: false, error: messageOverride ?? errorMessage(err) };
}

export function preflightEnum<T extends string>(
  value: unknown,
  allowed: readonly T[],
  field: string,
  toolName: string,
): { ok: true; value: T | undefined } | { ok: false; error: string } {
  if (value === undefined) return { ok: true, value: undefined };
  if (typeof value !== 'string') {
    const message = `${toolName} failed: field '${field}' must be a string. Allowed values: ${allowed.join(', ')}. See the '${toolName}' tool's parameter schema.`;
    return { ok: false, error: message };
  }
  const matched = allowed.find((candidate) => candidate === value);
  if (matched === undefined) {
    const message = `${toolName} failed: field '${field}' received '${value}', which is not a valid value. Allowed values: ${allowed.join(', ')}. See the '${toolName}' tool's parameter schema.`;
    return { ok: false, error: message };
  }
  return { ok: true, value: matched };
}

export function isBinarySample(buf: Buffer): boolean {
  if (buf.length === 0) return false;
  let suspicious = 0;
  const sample = Math.min(buf.length, 1024);
  for (let i = 0; i < sample; i += 1) {
    const b = buf[i];
    if (b === 0) return true;
    if (b < 7 || (b > 14 && b < 32)) suspicious += 1;
  }
  return suspicious / sample > 0.3;
}
