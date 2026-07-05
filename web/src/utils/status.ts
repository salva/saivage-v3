import type { CardStatus, CardType } from '../api/types';

export type Tone =
  | 'neutral'
  | 'active'
  | 'success'
  | 'warning'
  | 'danger'
  | 'pending'
  | 'stale'
  | 'unauthorized'
  | 'offline';

export interface UiStatus {
  label: string;
  tone: Tone;
  description?: string;
}

export const cardStatusTone: Record<CardStatus, Tone> = {
  backlog: 'neutral',
  running: 'active',
  blocked: 'warning',
  changed: 'warning',
  done: 'success',
  failed: 'danger',
  cancelled: 'neutral',
  needs_verification: 'warning',
};

export const cardTypeLabel: Record<CardType, string> = {
  project: 'Project',
  goal: 'Goal',
  architecture: 'Architecture',
  code: 'Code',
  test: 'Test',
  doc: 'Doc',
  data: 'Data',
  research: 'Research',
  ops: 'Ops',
};

export const cardTypeShort: Record<CardType, string> = {
  project: 'Proj',
  goal: 'Goal',
  architecture: 'Arch',
  code: 'Code',
  test: 'Test',
  doc: 'Doc',
  data: 'Data',
  research: 'Res',
  ops: 'Ops',
};

export function toneForCardStatus(status: CardStatus): Tone {
  return cardStatusTone[status] ?? 'neutral';
}

export function labelForCardType(type: CardType): string {
  return cardTypeLabel[type] ?? type;
}

export function shortLabelForCardType(type: CardType): string {
  return cardTypeShort[type] ?? type;
}
