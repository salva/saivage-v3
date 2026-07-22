import { cardActionValues } from '../schemas/index.js';
import type { CardAction, CardStatus } from '../schemas/index.js';
import { canCancelCardStatus } from '../cards/status-api.js';

function assertNever(value: never): never {
  throw new Error(`Unhandled card action: ${String(value)}`);
}

function isOperatorCardActionAllowed(action: CardAction, status: CardStatus): boolean {
  switch (action) {
    case 'card.start': return status === 'backlog' || status === 'changed' || status === 'stopped';
    case 'card.create': return false;
    case 'card.cancel': return canCancelCardStatus(status);
    case 'card.delete': return status !== 'running';
    case 'card.reorder_child': return false;
    default: return assertNever(action);
  }
}

export function allowedOperatorCardActions(status: CardStatus): CardAction[] {
  return cardActionValues.filter((action) => isOperatorCardActionAllowed(action, status));
}
