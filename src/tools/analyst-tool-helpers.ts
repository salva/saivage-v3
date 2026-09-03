import { PROJECT_CARD_ID, type CardService } from '../cards/card-api.js';
import type { CardTypeName } from '../schemas/index.js';
import type { AnalystToolOutcome, SafeToolData } from './analyst-tool-types.js';
import { throwIfPublicationOutcomeUnknown } from '../contracts/index.js';
import { toolFailed } from '../contracts/tool-result.js';

export function defaultParentForCreate(store: CardService, type: CardTypeName): string | null | undefined {
  if (type === 'project') return null;
  const requestedWorkflow = store.workflows.cardTypes.get(type);
  if (!requestedWorkflow) throw new Error(`No compiled workflow exists for card type '${type}'.`);
  if (requestedWorkflow.permittedChildTypes.size > 0) return PROJECT_CARD_ID;
  const candidates = store.list().filter((card) => {
    if (card.id === PROJECT_CARD_ID) return false;
    const workflow = store.workflows.cardTypes.get(card.type);
    if (!workflow) throw new Error(`No compiled workflow exists for card type '${card.type}'.`);
    return workflow.permittedChildTypes.size > 0 && workflow.permittedChildTypes.has(type);
  });
  const preferred = candidates.filter((card) => ['running', 'backlog', 'blocked', 'stopped'].includes(card.lifecycle.status));
  if (preferred.length === 1) return preferred[0]!.id;
  if (candidates.length === 1) return candidates[0]!.id;
  return PROJECT_CARD_ID;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function toolFailure(message: string, safeData?: SafeToolData): AnalystToolOutcome {
  return toolFailed(message, safeData);
}

export function toolFailureFromError(err: unknown, messageOverride?: string): AnalystToolOutcome {
  throwIfPublicationOutcomeUnknown(err);
  return toolFailed(messageOverride ?? errorMessage(err));
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
