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
  indicator?: 'ringed-dot';
}

export const cardStatusTone: Record<CardStatus, Tone> = {
  backlog: 'neutral',
  running: 'active',
  blocked: 'warning',
  changed: 'warning',
  stopped: 'success',
  done: 'success',
  failed: 'danger',
  cancelled: 'neutral',
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

export function statusForCard(status: CardStatus, description?: string): UiStatus {
  return {
    label: status,
    tone: toneForCardStatus(status),
    description,
    ...(status === 'stopped' ? { indicator: 'ringed-dot' as const } : {}),
  };
}

export function labelForCardType(type: CardType): string {
  return cardTypeLabel[type] ?? type;
}

export function shortLabelForCardType(type: CardType): string {
  return cardTypeShort[type] ?? type;
}

export const runtimeStatusTone: Record<string, Tone> = {
  running: 'success',
  stopped: 'offline',
  paused: 'warning',
  error: 'danger',
  unknown: 'neutral',
  unavailable: 'neutral',
};

export function statusForRuntimeStatus(label: string, description?: string): UiStatus {
  return { label, tone: runtimeStatusTone[label] ?? 'neutral', description };
}
