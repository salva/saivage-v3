import { describe, expect, it } from '@jest/globals';

import { allowedActions, decide } from '../../src/permissions/index.js';
import { CARD_ACTIONS, CARD_STATES, PERMISSION_ROLES } from '../../src/permissions/card-permissions.js';

describe('permission-by-state matrix', () => {
  it('has an explicit decision for every current role/action/state triple', () => {
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
    expect(decide({ role: 'planner', action: 'card.restart', targetState: 'failed' })).toEqual({ allowed: true });
    expect(decide({ role: 'planner', action: 'card.restart', targetState: 'running' })).toEqual({ allowed: false, reason: 'wrong_state' });
    expect(decide({ role: 'reviewer', action: 'card.delete', targetState: 'failed' })).toEqual({ allowed: false, reason: 'not_authorized' });
    expect(decide({ role: 'analyst', action: 'card.create', targetState: 'backlog' })).toEqual({ allowed: true });
    expect(decide({ role: 'analyst', action: 'card.create', targetState: 'running' })).toEqual({ allowed: false, reason: 'wrong_state' });
    expect(decide({ role: 'analyst', action: 'card.cancel', targetState: 'needs_verification' })).toEqual({ allowed: true });
    expect(decide({ role: 'analyst', action: 'card.cancel', targetState: 'done' })).toEqual({ allowed: false, reason: 'wrong_state' });
    expect(decide({ role: 'analyst', action: 'card.delete', targetState: 'changed' })).toEqual({ allowed: true });
    expect(decide({ role: 'analyst', action: 'card.delete', targetState: 'needs_verification' })).toEqual({ allowed: true });
    expect(decide({ role: 'analyst', action: 'card.restart', targetState: 'done' })).toEqual({ allowed: false, reason: 'not_authorized' });
    expect(decide({ role: 'analyst', action: 'card.reorder_child', targetState: 'changed' })).toEqual({ allowed: true });
    expect(decide({ role: 'analyst', action: 'card.reorder_child', targetState: 'running' })).toEqual({ allowed: false, reason: 'wrong_state' });
    expect(allowedActions('operator', 'failed')).toContain('card.restart');
    expect(allowedActions('operator', 'running')).not.toContain('card.restart');
  });
});
