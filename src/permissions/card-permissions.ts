import type { CardStatus } from '../schemas/types.js';

export const PERMISSION_ROLES = ['operator', 'planner', 'analyst', 'executor', 'reviewer'] as const;
export type PermissionRole = (typeof PERMISSION_ROLES)[number];

export const CARD_ACTIONS = ['card.start', 'card.cancel', 'card.delete', 'card.restart'] as const;
export type CardAction = (typeof CARD_ACTIONS)[number];

export const CARD_STATES = ['drafting', 'backlog', 'active', 'running', 'blocked', 'changed', 'done', 'failed', 'cancelled'] as const satisfies readonly CardStatus[];
export type CardState = (typeof CARD_STATES)[number];

export type DenyReason = 'wrong_state' | 'not_authorized' | 'card_archived';

export type Decision =
  | { allowed: true }
  | { allowed: false; reason: DenyReason };

interface MatrixEntry {
  role: PermissionRole;
  action: CardAction;
  states: readonly CardState[] | '*';
  allowed: boolean;
  deny?: DenyReason;
}

const PLANNER_MUTABLE_STATES = ['backlog', 'active', 'changed'] as const satisfies readonly CardState[];
const DELETABLE_STATES = ['backlog', 'blocked', 'done', 'failed', 'cancelled'] as const satisfies readonly CardState[];
const RESTARTABLE_STATES = ['blocked', 'changed', 'done', 'failed', 'cancelled'] as const satisfies readonly CardState[];

const matrixEntries = [
  { role: 'planner', action: 'card.start', states: ['drafting', 'backlog', 'changed'], allowed: true },
  { role: 'planner', action: 'card.cancel', states: PLANNER_MUTABLE_STATES, allowed: true },
  { role: 'planner', action: 'card.delete', states: DELETABLE_STATES, allowed: true },
  { role: 'planner', action: 'card.restart', states: RESTARTABLE_STATES, allowed: true },

  { role: 'operator', action: 'card.start', states: ['drafting', 'backlog', 'changed'], allowed: true },
  { role: 'operator', action: 'card.cancel', states: PLANNER_MUTABLE_STATES, allowed: true },
  { role: 'operator', action: 'card.delete', states: DELETABLE_STATES, allowed: true },
  { role: 'operator', action: 'card.restart', states: RESTARTABLE_STATES, allowed: true },

  { role: 'analyst', action: 'card.start', states: '*', allowed: false, deny: 'not_authorized' },
  { role: 'analyst', action: 'card.cancel', states: '*', allowed: false, deny: 'not_authorized' },
  { role: 'analyst', action: 'card.delete', states: DELETABLE_STATES, allowed: true },
  { role: 'analyst', action: 'card.restart', states: ['done', 'failed', 'cancelled'], allowed: true },

  { role: 'executor', action: 'card.start', states: '*', allowed: false, deny: 'not_authorized' },
  { role: 'executor', action: 'card.cancel', states: '*', allowed: false, deny: 'not_authorized' },
  { role: 'executor', action: 'card.delete', states: '*', allowed: false, deny: 'not_authorized' },
  { role: 'executor', action: 'card.restart', states: '*', allowed: false, deny: 'not_authorized' },

  { role: 'reviewer', action: 'card.start', states: '*', allowed: false, deny: 'not_authorized' },
  { role: 'reviewer', action: 'card.cancel', states: '*', allowed: false, deny: 'not_authorized' },
  { role: 'reviewer', action: 'card.delete', states: '*', allowed: false, deny: 'not_authorized' },
  { role: 'reviewer', action: 'card.restart', states: '*', allowed: false, deny: 'not_authorized' },
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

export function matrixCompletenessTriples(): Array<{ role: PermissionRole; action: CardAction; state: CardState; decision: Decision }> {
  return PERMISSION_ROLES.flatMap((role) => CARD_ACTIONS.flatMap((action) => CARD_STATES.map((state) => ({ role, action, state, decision: decide({ role, action, targetState: state }) }))));
}

export const TOOL_TO_CARD_ACTION = {
  activate_card: 'card.start',
  cancel_card: 'card.cancel',
  delete_card: 'card.delete',
  restart_card: 'card.restart',
} as const satisfies Record<string, CardAction>;

export function cardActionForPlannerTool(toolName: string): CardAction | undefined {
  return TOOL_TO_CARD_ACTION[toolName as keyof typeof TOOL_TO_CARD_ACTION];
}
