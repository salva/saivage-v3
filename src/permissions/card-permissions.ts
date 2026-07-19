import { cardActionValues, cardStatusValues, type CardStatus } from '../schemas/index.js';

export const PERMISSION_ROLES = ['operator', 'planner', 'analyst', 'executor', 'reviewer'] as const;
export type PermissionRole = (typeof PERMISSION_ROLES)[number];

export const CARD_ACTIONS = cardActionValues;
export type CardAction = (typeof CARD_ACTIONS)[number];

export const CARD_STATES = cardStatusValues satisfies readonly CardStatus[];
export type CardState = (typeof CARD_STATES)[number];

export type DenyReason = 'wrong_state' | 'not_authorized' | 'card_archived';

export type Decision =
  | { allowed: true }
  | { allowed: false; reason: DenyReason };

export interface MatrixEntry {
  role: PermissionRole;
  action: CardAction;
  states: readonly CardState[] | '*';
  allowed: boolean;
  deny?: DenyReason;
}

const PLANNER_MUTABLE_STATES = ['backlog', 'changed', 'stopped'] as const satisfies readonly CardState[];
const DELETABLE_STATES = ['backlog', 'blocked', 'stopped', 'done', 'failed', 'cancelled'] as const satisfies readonly CardState[];
const ANALYST_CANCELABLE_STATES = ['backlog', 'changed', 'blocked', 'stopped'] as const satisfies readonly CardState[];
const ANALYST_CREATABLE_PARENT_STATES = ['backlog', 'changed', 'blocked', 'stopped', 'done', 'failed', 'cancelled'] as const satisfies readonly CardState[];
const ANALYST_DELETABLE_STATES = ['backlog', 'changed', 'blocked', 'stopped', 'done', 'failed', 'cancelled'] as const satisfies readonly CardState[];
const ANALYST_REORDERABLE_STATES = ANALYST_CREATABLE_PARENT_STATES;
export const STARTABLE_STATES = ['backlog', 'changed', 'stopped'] as const satisfies readonly CardState[];
export const TERMINAL_STATUSES: ReadonlySet<CardStatus> = new Set<CardStatus>(['done', 'failed', 'cancelled']);

function exceptStates(states: readonly CardState[]): CardState[] {
  return CARD_STATES.filter((state) => !states.includes(state));
}

const NOT_STARTABLE_STATES = exceptStates(STARTABLE_STATES);
const PLANNER_NOT_MUTABLE_STATES = exceptStates(PLANNER_MUTABLE_STATES);
const NOT_DELETABLE_STATES = exceptStates(DELETABLE_STATES);
const ANALYST_NOT_CANCELABLE_STATES = exceptStates(ANALYST_CANCELABLE_STATES);
const ANALYST_NOT_CREATABLE_PARENT_STATES = exceptStates(ANALYST_CREATABLE_PARENT_STATES);
const ANALYST_NOT_DELETABLE_STATES = exceptStates(ANALYST_DELETABLE_STATES);
const ANALYST_NOT_REORDERABLE_STATES = exceptStates(ANALYST_REORDERABLE_STATES);

const matrixEntries = [
  { role: 'planner', action: 'card.start', states: STARTABLE_STATES, allowed: true },
  { role: 'planner', action: 'card.start', states: NOT_STARTABLE_STATES, allowed: false, deny: 'wrong_state' },
  { role: 'planner', action: 'card.create', states: '*', allowed: false, deny: 'not_authorized' },
  { role: 'planner', action: 'card.cancel', states: PLANNER_MUTABLE_STATES, allowed: true },
  { role: 'planner', action: 'card.cancel', states: PLANNER_NOT_MUTABLE_STATES, allowed: false, deny: 'wrong_state' },
  { role: 'planner', action: 'card.delete', states: DELETABLE_STATES, allowed: true },
  { role: 'planner', action: 'card.delete', states: NOT_DELETABLE_STATES, allowed: false, deny: 'wrong_state' },
  { role: 'planner', action: 'card.reorder_child', states: '*', allowed: false, deny: 'not_authorized' },

  { role: 'operator', action: 'card.start', states: STARTABLE_STATES, allowed: true },
  { role: 'operator', action: 'card.start', states: NOT_STARTABLE_STATES, allowed: false, deny: 'wrong_state' },
  { role: 'operator', action: 'card.create', states: '*', allowed: false, deny: 'not_authorized' },
  { role: 'operator', action: 'card.cancel', states: PLANNER_MUTABLE_STATES, allowed: true },
  { role: 'operator', action: 'card.cancel', states: PLANNER_NOT_MUTABLE_STATES, allowed: false, deny: 'wrong_state' },
  { role: 'operator', action: 'card.delete', states: DELETABLE_STATES, allowed: true },
  { role: 'operator', action: 'card.delete', states: NOT_DELETABLE_STATES, allowed: false, deny: 'wrong_state' },
  { role: 'operator', action: 'card.reorder_child', states: '*', allowed: false, deny: 'not_authorized' },

  { role: 'analyst', action: 'card.start', states: '*', allowed: false, deny: 'not_authorized' },
  { role: 'analyst', action: 'card.create', states: ANALYST_CREATABLE_PARENT_STATES, allowed: true },
  { role: 'analyst', action: 'card.create', states: ANALYST_NOT_CREATABLE_PARENT_STATES, allowed: false, deny: 'wrong_state' },
  { role: 'analyst', action: 'card.cancel', states: ANALYST_CANCELABLE_STATES, allowed: true },
  { role: 'analyst', action: 'card.cancel', states: ANALYST_NOT_CANCELABLE_STATES, allowed: false, deny: 'wrong_state' },
  { role: 'analyst', action: 'card.delete', states: ANALYST_DELETABLE_STATES, allowed: true },
  { role: 'analyst', action: 'card.delete', states: ANALYST_NOT_DELETABLE_STATES, allowed: false, deny: 'wrong_state' },
  { role: 'analyst', action: 'card.reorder_child', states: ANALYST_REORDERABLE_STATES, allowed: true },
  { role: 'analyst', action: 'card.reorder_child', states: ANALYST_NOT_REORDERABLE_STATES, allowed: false, deny: 'wrong_state' },

  { role: 'executor', action: 'card.start', states: '*', allowed: false, deny: 'not_authorized' },
  { role: 'executor', action: 'card.create', states: '*', allowed: false, deny: 'not_authorized' },
  { role: 'executor', action: 'card.cancel', states: '*', allowed: false, deny: 'not_authorized' },
  { role: 'executor', action: 'card.delete', states: '*', allowed: false, deny: 'not_authorized' },
  { role: 'executor', action: 'card.reorder_child', states: '*', allowed: false, deny: 'not_authorized' },

  { role: 'reviewer', action: 'card.start', states: '*', allowed: false, deny: 'not_authorized' },
  { role: 'reviewer', action: 'card.create', states: '*', allowed: false, deny: 'not_authorized' },
  { role: 'reviewer', action: 'card.cancel', states: '*', allowed: false, deny: 'not_authorized' },
  { role: 'reviewer', action: 'card.delete', states: '*', allowed: false, deny: 'not_authorized' },
  { role: 'reviewer', action: 'card.reorder_child', states: '*', allowed: false, deny: 'not_authorized' },
] as const satisfies readonly MatrixEntry[];

function entryMatches(entry: MatrixEntry, role: PermissionRole, action: CardAction, state: CardState): boolean {
  return entry.role === role && entry.action === action && (entry.states === '*' || entry.states.includes(state));
}

export function decide(input: { role: PermissionRole; action: CardAction; targetState: CardState }): Decision {
  const entry = matrixEntries.find((candidate) => entryMatches(candidate, input.role, input.action, input.targetState));
  if (!entry) return { allowed: false, reason: 'wrong_state' };
  if (entry.allowed) return { allowed: true };
  return { allowed: false, reason: entry.deny ?? 'wrong_state' };
}

export function allowedActions(role: PermissionRole, state: CardState): CardAction[] {
  return CARD_ACTIONS.filter((action) => decide({ role, action, targetState: state }).allowed);
}
