import type { CardStatus } from '../schemas/index.js';
import { STARTABLE_STATES, RESTARTABLE_STATES, TERMINAL_STATUSES } from '../permissions/index.js';
import type { RuntimeCardAction } from './state-machine.js';

export type ActivationAction =
  | { action: 'start'; reason: string }
  | { action: 'restart'; reason: string }
  | { action: 'reviewer_repair_resume'; reason: string }
  | { action: 'none'; reason: string }
  | { action: 'reject'; reason: string };

export function selectActivationStartAction(
  fromStatus: CardStatus,
  role: 'planner' | 'executor',
): ActivationAction {
  if ((STARTABLE_STATES as readonly CardStatus[]).includes(fromStatus)) {
    return { action: 'start', reason: 'startable_status' };
  }
  if ((RESTARTABLE_STATES as readonly CardStatus[]).includes(fromStatus)) {
    return { action: 'restart', reason: 'restartable_status' };
  }
  if (role === 'executor') {
    if (fromStatus === 'running') return { action: 'none', reason: 'already_running' };
  }
  if (role === 'planner' && fromStatus === 'running') {
    return { action: 'none', reason: 'already_active' };
  }
  return { action: 'reject', reason: 'invalid_activation_status' };
}

export interface PlanCardTransitionInput {
  action: RuntimeCardAction;
  fromStatus: CardStatus;
  payload?: Record<string, unknown>;
  canTransition: (toStatus: CardStatus) => boolean;
}

export type CardTransitionPlan =
  | { accepted: true; steps: CardStatus[] }
  | { accepted: false; code: 'state_machine_planner_status_rejected' | 'state_machine_invalid_source_state' };

export function planCardTransition(input: PlanCardTransitionInput): CardTransitionPlan {
  const { action, fromStatus: from } = input;
  const payload = input.payload ?? {};
  const rejectCode = action === 'planner_set_status'
    ? 'state_machine_planner_status_rejected'
    : 'state_machine_invalid_source_state';
  const accept = (steps: CardStatus[]): CardTransitionPlan => ({ accepted: true, steps });
  const reject = (): CardTransitionPlan => ({ accepted: false, code: rejectCode });

  switch (action) {
    case 'start':
      if (!(STARTABLE_STATES as readonly CardStatus[]).includes(from)) return reject();
      switch (from) {
        case 'backlog': return accept(['running']);
        case 'changed': return accept(['running']);
        default: return reject();
      }
    case 'restart':
      if (!(RESTARTABLE_STATES as readonly CardStatus[]).includes(from)) return reject();
      switch (from) {
        case 'failed': return accept(['backlog', 'running']);
        case 'done': return accept(['backlog', 'running']);
        case 'cancelled': return accept(['backlog', 'running']);
        case 'blocked': return accept(['backlog', 'running']);
        case 'changed': return accept(['running']);
        default: return reject();
      }
    case 'cancel':
      return input.canTransition('cancelled') ? accept(['cancelled']) : reject();
    case 'planner_set_status': {
      const requested = payload.requestedStatus as CardStatus | undefined;
      if (!requested) return reject();
      if (from === requested) return accept([]);
      return input.canTransition(requested) ? accept([requested]) : reject();
    }
    case 'block':
      if (from === 'running') return accept(['blocked']);
      return reject();
    case 'complete':
      if (from === 'running') return accept(['done']);
      return reject();
    case 'fail':
      if (TERMINAL_STATUSES.has(from)) return reject();
      switch (from) {
        case 'running': return accept(['failed']);
        case 'backlog': return accept(['running', 'failed']);
        case 'blocked': return accept(['running', 'failed']);
        case 'changed': return accept(['running', 'failed']);
        default: return reject();
      }
    case 'executor_finish': {
      if (from !== 'running') return reject();
      const finalStatus = payload.finalStatus as CardStatus | undefined;
      if (finalStatus === 'done') return accept(['done']);
      if (finalStatus === 'failed') return accept(['failed']);
      return reject();
    }
    case 'executor_partial_finish':
      if (from !== 'running') return reject();
      return accept(['needs_verification']);
    case 'reviewer_repair_resume':
      if (from === 'running') return accept([]);
      return reject();
    case 'crash_recovery_drop_to_backlog':
      if (from === 'running') return accept(['backlog']);
      return reject();
    default:
      return reject();
  }
}
