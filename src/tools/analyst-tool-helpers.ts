import { PROJECT_CARD_ID, type CardService } from '../cards/card-api.js';
import type { CardType } from '../schemas/index.js';
import type { SafeToolData, ToolContext, ToolResult } from './analyst-tool-types.js';
import { throwIfPublicationOutcomeUnknown } from '../contracts/index.js';

export function getStore(ctx: ToolContext): CardService {
  return ctx.store;
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

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function toolFailure(message: string, safeData?: SafeToolData): ToolResult {
  return safeData === undefined ? { success: false, error: message } : { success: false, error: message, data: safeData };
}

export function toolFailureFromError(err: unknown, messageOverride?: string): ToolResult {
  throwIfPublicationOutcomeUnknown(err);
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
