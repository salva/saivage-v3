import { describe, expect, it } from '@jest/globals';

import { allowedActions, decide } from '../../src/permissions/index.js';
import { CARD_ACTIONS, CARD_STATES, PERMISSION_ROLES } from '../../src/permissions/card-permissions.js';
import { cardActionSchema } from '../../src/schemas/index.js';

describe('permission-by-state matrix', () => {
  it('has an explicit decision for every current role/action/state triple', () => {
    expect(CARD_ACTIONS).toEqual(['card.start', 'card.create', 'card.cancel', 'card.delete', 'card.reorder_child']);
    let count = 0;
    for (const role of PERMISSION_ROLES) {
      for (const action of CARD_ACTIONS) {
        for (const targetState of CARD_STATES) {
          count += 1;
          const decision = decide({ role, action, targetState });
          expect(typeof decision.allowed).toBe('boolean');
          if (!decision.allowed) expect(decision.reason).toMatch(/^(wrong_state|not_authorized|card_archived)$/);
        }
      }
    }
    expect(count).toBe(PERMISSION_ROLES.length * CARD_ACTIONS.length * CARD_STATES.length);
  });

  it('allows and denies representative lifecycle decisions from the central matrix', () => {
    expect(decide({ role: 'planner', action: 'card.start', targetState: 'stopped' })).toEqual({ allowed: true });
    expect(decide({ role: 'planner', action: 'card.start', targetState: 'failed' })).toEqual({ allowed: false, reason: 'wrong_state' });
    expect(decide({ role: 'reviewer', action: 'card.delete', targetState: 'failed' })).toEqual({ allowed: false, reason: 'not_authorized' });
    expect(decide({ role: 'analyst', action: 'card.create', targetState: 'backlog' })).toEqual({ allowed: true });
    expect(decide({ role: 'analyst', action: 'card.create', targetState: 'running' })).toEqual({ allowed: false, reason: 'wrong_state' });
    expect(decide({ role: 'analyst', action: 'card.cancel', targetState: 'blocked' })).toEqual({ allowed: true });
    expect(decide({ role: 'analyst', action: 'card.cancel', targetState: 'done' })).toEqual({ allowed: false, reason: 'wrong_state' });
    expect(decide({ role: 'analyst', action: 'card.delete', targetState: 'changed' })).toEqual({ allowed: true });
    expect(decide({ role: 'analyst', action: 'card.reorder_child', targetState: 'changed' })).toEqual({ allowed: true });
    expect(decide({ role: 'analyst', action: 'card.reorder_child', targetState: 'running' })).toEqual({ allowed: false, reason: 'wrong_state' });
    expect(allowedActions('operator', 'failed')).toEqual(['card.cancel', 'card.delete']);
    expect(allowedActions('operator', 'running')).toEqual(['card.cancel']);
  });

  it('rejects removed card.restart action vocabulary', () => {
    expect(cardActionSchema.safeParse('card.restart').success).toBe(false);
  });

  it('classifies stopped exhaustively for every role', () => {
    expect(allowedActions('planner', 'stopped')).toEqual(['card.start', 'card.cancel', 'card.delete']);
    expect(allowedActions('operator', 'stopped')).toEqual(['card.start', 'card.cancel', 'card.delete']);
    expect(allowedActions('analyst', 'stopped')).toEqual(['card.create', 'card.cancel', 'card.delete', 'card.reorder_child']);
    expect(allowedActions('executor', 'stopped')).toEqual([]);
    expect(allowedActions('reviewer', 'stopped')).toEqual([]);
  });
});
