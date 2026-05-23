import { describe, expect, it } from '@jest/globals';

import { allowedActions, decide } from '../../src/permissions/index.js';
import { CARD_ACTIONS, CARD_STATES, matrixCompletenessTriples, PERMISSION_ROLES } from '../../src/permissions/card-permissions.js';

describe('permission-by-state matrix', () => {
  it('has an explicit decision for every current role/action/state triple', () => {
    const triples = matrixCompletenessTriples();
    expect(triples).toHaveLength(PERMISSION_ROLES.length * CARD_ACTIONS.length * CARD_STATES.length);
    for (const triple of triples) {
      expect(triple.entries).toHaveLength(1);
      expect(typeof triple.decision.allowed).toBe('boolean');
      if (!triple.decision.allowed) expect(triple.decision.reason).toMatch(/^(wrong_state|not_authorized|card_archived)$/);
    }
  });

  it('allows and denies representative lifecycle decisions from the central matrix', () => {
    expect(decide({ role: 'planner', action: 'card.restart', targetState: 'failed' })).toEqual({ allowed: true });
    expect(decide({ role: 'planner', action: 'card.restart', targetState: 'running' })).toEqual({ allowed: false, reason: 'wrong_state' });
    expect(decide({ role: 'reviewer', action: 'card.delete', targetState: 'failed' })).toEqual({ allowed: false, reason: 'not_authorized' });
    expect(allowedActions('operator', 'failed')).toContain('card.restart');
    expect(allowedActions('operator', 'running')).not.toContain('card.restart');
  });
});
