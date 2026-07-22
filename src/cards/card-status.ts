import type { CardStatus } from '../schemas/index.js';

export function canCreateChildInStatus(status: CardStatus): boolean {
  return status === 'backlog' || status === 'changed' || status === 'running' || status === 'blocked' || status === 'stopped';
}

export function canCancelCardStatus(status: CardStatus): boolean {
  return status !== 'done' && status !== 'cancelled';
}

export function acceptsCardNotifications(status: CardStatus): boolean {
  return status === 'backlog' || status === 'changed' || status === 'running' || status === 'blocked' || status === 'stopped';
}

export function analystRecordEditEffect(status: CardStatus): 'preserve' | 'reopen' | null {
  if (status === 'backlog' || status === 'running' || status === 'stopped') return 'preserve';
  if (status === 'blocked' || status === 'done' || status === 'failed') return 'reopen';
  return null;
}
